/**
 * Provides an HTTP service endpoint that allows HTTP users to check a
 * particular spec against a given crawl report to produce a new anomalies
 * report.
 *
 * @module httpService
 */

const path = require('path');
const express = require('express');
const morgan = require('morgan');
const compression = require('compression');
const bodyParser = require('body-parser');
const URL = require('whatwg-url').URL;
const crawlList = require('reffy/crawl-specs').crawlList;
const mergeCrawlResults = require('reffy/merge-crawl-results').mergeCrawlResults;
const studyCrawl = require('reffy/study-crawl').studyCrawl;
const promisifyRequire = require('promisify-require');
const fs = promisifyRequire('fs');
const fetch = require('fetch-filecache-for-crawling');
const config = require('./config.json');
const app = express();
const httpPort = config.httpPort || 3000;
config.crawlReports = config.crawlReports ||
  'https://tidoust.github.io/reffy-reports/';

function ParamError(message) {
  this.name = 'ParamError';
  this.message = message || '';
}
ParamError.prototype = Error.prototype;


function CheckError(message) {
  this.name = 'CheckError';
  this.message = message || '';
}
CheckError.prototype = Error.prototype;


/**
 * HTTP request identifier (incremented after each request)
 */
let requestID = 0;



/**
 * Return the shortname of a specification
 *
 * TODO: that logic should rather be exposed by Reffy than copied from it
 * to avoid having to maintain code in sync...
 *
 * @param  {Object} spec The spec whose shortname we're interested in
 * @return {String} Shortname to use to reference the spec
 */
function getShortname(spec) {
  if (spec.shortname) {
    // do not include versionning
    return spec.shortname.replace(/-?[0-9]*$/, '');
  }
  const whatwgMatch = spec.url.match(/\/\/(.*)\.spec.whatwg.org\/$/);
  if (whatwgMatch) {
    return whatwgMatch[1];
  }
  const khronosMatch = spec.url.match(/https:\/\/www.khronos.org\/registry\/webgl\/specs\/latest\/([12]).0\/$/);
  if (khronosMatch) {
    return "webgl" + khronosMatch[1];
  }
  const githubMatch = spec.url.match(/\/.*.github.io\/([^\/]*)\//);
  if (githubMatch) {
    return githubMatch[1];
  }
  return spec.url.replace(/[^-a-z0-9]/g, '');
}


/**
 * Shortcut that returns a property extractor iterator
 */
function prop(p) {
  return x => x[p];
}


/**
 * Wrapper around the "require" function to require files relative to the
 * current working directory (CWD), instead of relative to the current JS
 * file.
 *
 * This is typically needed to be able to use "require" to load JSON config
 * files provided as command-line arguments.
 *
 * @function
 * @param {String} filename The path to the file to require
 * @return {Object} The result of requiring the file relative to the current
 *   working directory.
 */
function requireFromWorkingDirectory(filename) {
  return require(path.resolve(filename));
}


/**
 * Extract query parameters from HTTP request
 *
 * @param  {Request} req HTTP request
 * @return {Promise(Object)} Promise to get query parameters
 */
async function getQueryFromRequest(req) {
  if (req.method === 'GET') {
    return {
      specs: ((req.query.urls || req.query.url) ? (req.query.urls || req.query.url).split(',') : []).map(url => { return { url }; }),
      crawl: req.query.crawl,
      report: (req.query.report ? req.query.report.split(',') : ['analysis'])
    };
  }
  else if (req.body && req.body.specs) {
    return {
      specs: req.body.specs,
      crawl: req.body.crawl,
      report: (req.body.report ? (Array.isArray(req.body.report) ? req.body.report : req.body.report.split(',')) : ['analysis'])
    };
  }
  else {
    return {
      specs: [{
        url: req.body.url,
        html: req.body.html
      }],
      crawl: req.body.crawl,
      report: (req.body.report ? (Array.isArray(req.body.report) ? req.body.report : req.body.report.split(',')) : ['analysis'])
    };
  }
}


/**
 * Validates the given URL, makind sure it is an absolute HTTP/HTTPS URL (that
 * does not target "localhost" in production mode)
 *
 * @param {String} url URL to validate
 * @return {Boolean} True when URL is ok
 */
function checkUrl(url) {
  try {
    let parsedUrl = new URL(url);
    if ((parsedUrl.protocol !== 'http:') && (parsedUrl.protocol !== 'https:')) {
      return false;
    }
    return true;
  }
  catch (err) {
    try {
      let parsedUrl = new URL(`https://www.w3.org/TR/${url}`);
      return true;
    }
    catch (err) {
      return false;
    }
  }
}


/**
 * Validates the query received by the service
 *
 * @param  {Object} query Query parameters
 * @return {Promise(Object)} The promise to get a valid query with trusted
 * properties. Rejected when some query parameter is missing or incorrect
 */
async function validateQuery(query) {
  if (!query || !query.specs || (query.specs.length === 0)) {
    throw new ParamError('No spec to check');
  }
  else if (query.specs.some(spec => !spec.url && !spec.html)) {
    throw new ParamError('Empty spec description received.');
  }
  else if (query.specs.some(spec => spec.url && !checkUrl(spec.url))) {
    throw new ParamError('Invalid spec url received. It must be an absolute HTTP(S) address.');
  }
  else if (query.crawl && !['w3c', 'w3c-tr', 'whatwg'].includes(query.crawl)) {
    throw new ParamError('The "crawl" parameter must be one of "w3c", "w3c-tr" or "whatwg".');
  }
  else if (query.report.some(report => !['all', 'idl', 'crawl', 'analysis'].includes(report))) {
    throw new ParamError('The "report" parameter must be one (or more) of "idl", "crawl", or "analysis".');
  }
  else {
    query.crawl = query.crawl || 'w3c';
    if (query.report.some(report => report === 'all')) {
      query.report = ['idl', 'crawl', 'analysis'];
    }
    return query;
  }
}


/**
 * Find the requested spec in the results array
 * 
 * @param {Object} spec The specification to find
 * @param {Array} results The results to parse
 * @return {Object} The matching spec in the results array or null
 */
function findSpecInResults(spec, results) {
  let url = spec.url.replace(/^http:/, 'https:');
  let result =
    results.find(s => (s.url === url) || (s.crawled === url)) ||
    results.find(s => s.versions && s.versions.includes(url)) ||
    results.find(s => s.shortname === url);
  if (!result) {
    url = url.endsWith('/') ? url.slice(0, -1) : url + '/';
    result =
      results.find(s => (s.url === url) || (s.crawled === url)) ||
      results.find(s => s.versions && s.versions.includes(url));
  }
  return result;
}


/**
 * Assemble the response to send base on query parameters, and the results
 * of the crawl (or the latest crawl report) and analysis
 *
 * @param  {Object} query The query parameters received
 * @param  {Array} crawl Crawl report
 * @param  {Array} study Analysis report
 * @return {Promise(Object)} Promise to get a response to send as JSON
 */
async function assembleResponse(query, crawl, study) {
  let result = {};
  for (spec of query.specs) {
    let crawlResult = findSpecInResults(spec, crawl);
    let studyResult = findSpecInResults(spec, study);
    let specResult = Object.assign(
      { url: spec.url },
      (query.report.includes('crawl') ? crawlResult : null),
      (query.report.includes('analysis') ? studyResult : null));
    if (query.report.includes('idl')) {
      // Return a few useful properties even when only the raw IDL
      // was requested
      if ((query.report.length === 1) && studyResult) {
        result[spec.url].title = studyResult.title;
        result[spec.url].date = studyResult.date;
        result[spec.url].crawled = studyResult.crawled;
      }

      try {
        result[spec.url].rawidl = await fs.readFile(path.resolve(
          config.crawlReports, query.crawl, 'idl',
          getShortname(studyResult || spec) + '.idl'), 'utf8');
      }
      catch (err) {
        // No IDL known, that's OK too
        result[spec.url].rawidl = '';
      }
    };
    if (!specResult.error &&
        (!specResult.title || (specResult.title === specResult.url))) {
      specResult.error = 'Not found';
    }
    result[spec.url] = specResult;
  }
  return result;
}


/**
 * Processes a valid request to check specs against the latest known crawl
 * report.
 *
 * @param  {Object} query Valid query to process
 * @return {Promise(Object)} The promise to get a freshly baked anomalies report
 * for the specs in the query
 */
async function processCheckQuery(query) {
  // Load latest crawl report
  let refCrawl = {};
  if (config.crawlReports.startsWith('http:') ||
      config.crawlReports.startsWith('https:')) {
    let response = await fetch(`${config.crawlReports}/${query.crawl}/crawl.json`);
    refCrawl = await response.json();
  }
  else {
    refCrawl = requireFromWorkingDirectory(
      path.resolve(config.crawlReports, query.crawl, 'crawl.json'));
  }
  refCrawl = refCrawl.results || [];

  let crawlOptions = { publishedVersion: (query.crawl === 'w3c-tr') };
  let crawlResults = await crawlList(query.specs, crawlOptions)
  let crawl = {
    type: 'crawl',
    title: 'Anomalies in spec: ' + query.specs.map(prop('url')).join(', '),
    description: 'Study of anomalies in the given spec against a reference crawl report',
    date: (new Date()).toJSON(),
    options: crawlOptions,
    stats: {
      crawled: crawlResults.length,
      errors: crawlResults.filter(spec => !!spec.error).length
    },
    results: crawlResults
  };
  let mergedCrawl = await mergeCrawlResults(crawl, refCrawl);
  let study = studyCrawl(mergedCrawl, query.specs);

  return assembleResponse(query, mergedCrawl.results, study.results);
}


/**
 * Processes a valid request to retrieve known information about given specs
 * within the latest known crawl report.
 *
 * @param  {Object} query Valid query to process
 * @return {Promise(Object)} The promise to get a JSON response to the query
 */
async function processSpecsQuery(query) {
  // Load latest crawl report if crawl info was requested
  let crawl = {};
  if (query.report.includes('crawl')) {
    if (config.crawlReports.startsWith('http:') ||
        config.crawlReports.startsWith('https:')) {
      let response = await fetch(`${config.crawlReports}/${query.crawl}/crawl.json`);
      crawl = await response.json();
    }
    else {
      crawl = requireFromWorkingDirectory(
        path.resolve(config.crawlReports, query.crawl, 'crawl.json'));
    }
    crawl = crawl.results || [];
  }

  // Load latest analysis if analysis info was requested or if IDL info was
  // requested (analysis info will help compute the shortname of the spec to
  // read the right IDL file)
  let study = {};
  if (query.report.includes('analysis') || query.report.includes('idl')) {
    if (config.crawlReports.startsWith('http:') ||
        config.crawlReports.startsWith('https:')) {
      let response = await fetch(`${config.crawlReports}/${query.crawl}/study.json`);
      study = response.json();
    }
    else {
      study = requireFromWorkingDirectory(
        path.resolve(config.crawlReports, query.crawl, 'study.json'));
    }
    study = study.results || [];
  }

  return assembleResponse(query, crawl, study);
}


/**
 * Returns a middleware that can process an incoming HTTP request and apply
 * the action specified
 *
 * @param  {function} processFunction The function to apply. Must accept a
 *   query object as parameter.
 * @return {function} An Express.js HTTP middleware
 */
function getRequestMiddleware(processFunction) {
  return (req, res, next) => {
    let reqID = requestID;
    requestID += 1;
    console.time(`request ${reqID}`);
    getQueryFromRequest(req)
      .then(validateQuery)
      .then(processFunction)
      .then(result => Object.assign({ status: 'ok' }, result))
      .then(result => res.json(result))
      .then(_ => next())
      .catch(err => next(err))
      .then(_ => console.timeEnd(`request ${reqID}`));
  };
}


// Prettify JSON response to ease debugging in development mode
// (note these settings are not taken into account when NODE_ENV=production)
app.set('json spaces', 2);


// Set up the logger, compression, and body parser middlewares
app.use(morgan('combined'));
app.use(compression());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());


///////////////////////////
// HTTP service endpoints
///////////////////////////

app.get('/check', getRequestMiddleware(processCheckQuery));
app.post('/check', getRequestMiddleware(processCheckQuery));
app.get('/specs', getRequestMiddleware(processSpecsQuery));
app.post('/specs', getRequestMiddleware(processSpecsQuery));


///////////////////////////
// Error handler
// (for all routes)
///////////////////////////
app.use(function (err, req, res, next) {
  console.error(err);

  if (res.headersSent) {
    return next(err);
  }

  if (err.name === 'ParamError') {
    res.status(403).json({
      err: {
        code: 403,
        message: err.message || 'Invalid query parameter received'
      }
    });
  }
  else {
    res.status(500).json({
      err: {
        code: 500,
        message: err.message || 'An internal error occurred'
      }
    });
  }
});


///////////////////////////
// Start the HTTP server
///////////////////////////

app.listen(httpPort, (err) => {
  if (err) {
    console.error(err);
    process.exit(64);
  }
  console.log('Started');
});