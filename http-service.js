/**
 * Provides an HTTP service endpoint that allows HTTP users to check a
 * particular spec against a given crawl report to produce a new anomalies
 * report.
 *
 * @module httpService
 */

const path = require('path');
const express = require('express');
const compression = require('compression');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const rimraf = require('rimraf');
const URL = require('whatwg-url').URL;
const crawlList = require('reffy/src/cli/crawl-specs').crawlList;
const mergeCrawlResults = require('reffy/src/cli/merge-crawl-results').mergeCrawlResults;
const studyCrawl = require('reffy/src/cli/study-crawl').studyCrawl;
const promisifyRequire = require('promisify-require');
const fs = promisifyRequire('fs');
const fetch = require('fetch-filecache-for-crawling');
const monitor = require('./monitor');
const app = express();


/**********************************************************************
Initialize HTTP service parameters from config.json file, or use
default values
**********************************************************************/
let config = null;
try {
  config = require('./config.json');
}
catch (err) {
  config = {};
}

/**
 * HTTP port number
 */
config.httpPort = config.httpPort || 3000;

/**
 * Where to get the crawl reports from. Defaults to fetching "reffy-reports"
 * published every day on GitHub
 */
config.crawlReports = config.crawlReports ||
  'https://tidoust.github.io/reffy-reports/';
if (config.crawlReports.startsWith('http:') ||
    config.crawlReports.startsWith('https:')) {
  if (!config.crawlReports.endsWith('/')) {
    config.crawlReports += '/';
  }
}

/**
 * Cache refresh strategy for crawl reports. Defaults to refreshing the contents
 * of the cache after 1/2 day for crawls. Possible values defined in:
 * https://github.com/tidoust/fetch-filecache-for-crawling#configuration
 */
config.crawlRefresh = config.crawlRefresh || 43200;

/**
 * Cache refresh strategy for specs to check. Defaults to forcing a new fetch
 * request each time as people usually want to check the latest version of a
 * spec, and not a cached version that could already be obsolete. Possible
 * values defined in:
 * https://github.com/tidoust/fetch-filecache-for-crawling#configuration
 */
config.cacheRefresh = config.cacheRefresh || 'force';

/**
 * Cache folder
 */
config.cacheFolder = config.cacheFolder || '.cache';


/**
 * Query cache folder (contains results of individual crawls)
 *
 * @type {[type]}
 */
config.queryCacheFolder = config.queryCacheFolder || '.querycache';

/**
 * Cache refresh strategy for query checks. Defaults to refreshing the contents
 * of the cache after one day. Possible values are "force" (which means the
 * cache will never be used), "never" (which means cache entries will always
 * be considered to be valid), or an integer (number of seconds before
 * expiration).
 *
 * Note the request may set a "refresh" parameter to "force" to force the
 * service to redo a crawl. This can be useful when the spec has not changed
 * but external scripts it uses have (e.g. ReSpec).
 */
config.queryCacheRefresh = config.queryCacheRefresh || 86400;


/**
 * Maximum number of entries to keep in the query cache folder
 *
 * Note that is a soft limit, meaning that the actual number of entries may
 * slightly exceed that number while the garbage collector does its job.
 *
 * Set the parameter to -1 to disable the garbage collector entirely.
 *
 * @type {Number}
 */
config.queryCacheMaxEntries = config.queryCacheMaxEntries || 10000;


/**
 * Whether to output additional execution traces to the console
 * (should only be set in debug mode)
 */
config.logToConsole = config.logToConsole || false;


/**
 * Error returned when a request parameter is missing or is not valid
 */
function ParamError(message) {
  this.name = 'ParamError';
  this.message = message || '';
}
ParamError.prototype = Error.prototype;


/**
 * HTTP request identifier (incremented after each request)
 */
let counter = 0;


/**
 * Number of entries in the query cache
 */
let inQueryCache = 0;


/**
 * Crawl reports in memory
 */
let crawlReports = {};


/**
 * Make sure that the query cache folder exists and is empty
 */
async function checkQueryCacheFolder() {
  try {
    let stat = await fs.stat(config.queryCacheFolder);
    if (!stat.isDirectory()) {
      throw new Error('Looking for a query cache folder but found a cache file instead');
    }
    rimraf.sync(config.queryCacheFolder + '/*');
  }
  catch (err) {
    // Create the folder if it does not exist yet
    if (err.code !== 'ENOENT') {
      throw err;
    }
    try {
      await fs.mkdir(config.queryCacheFolder);
    }
    catch (mkerr) {
      // Someone may have created the folder in the meantime
      if (mkerr.code !== 'EEXIST') {
        throw mkerr;
      }
    }
  }
}



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
    return spec.shortname.replace(/-?[0-9\.]*$/, '');
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
async function prepareQueryFromHttpRequest(req) {
  if (req.method === 'GET') {
    return {
      specs: ((req.query.urls || req.query.url) ? (req.query.urls || req.query.url).split(',') : []).map(url => { return { url }; }),
      crawl: req.query.crawl,
      report: (req.query.report ? req.query.report.split(',') : ['analysis']),
      refresh: req.query.refresh
    };
  }
  else if (req.body && req.body.specs) {
    return {
      specs: req.body.specs,
      crawl: req.body.crawl,
      report: (req.body.report ? (Array.isArray(req.body.report) ? req.body.report : req.body.report.split(',')) : ['analysis']),
      refresh: req.body.refresh
    };
  }
  else {
    return {
      specs: [{
        url: req.body.url,
        html: req.body.html
      }],
      crawl: req.body.crawl,
      report: (req.body.report ? (Array.isArray(req.body.report) ? req.body.report : req.body.report.split(',')) : ['analysis']),
      refresh: req.body.refresh
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
  else if (query.refresh && (query.refresh !== 'force')) {
    throw new ParamError('The "refresh" parameter can only be set to "force".');
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
        specResult.title = studyResult.title;
        specResult.date = studyResult.date;
        specResult.crawled = studyResult.crawled;
      }

      try {
        if (config.crawlReports.startsWith('http:') ||
            config.crawlReports.startsWith('https:')) {
          let response = await fetch(
            `${config.crawlReports}${query.crawl}/idl/${getShortname(studyResult || spec)}.idl`,
            { refresh: config.crawlRefresh }
          );
          if (response.status === 200) {
            specResult.rawidl = await response.text();
          }
          else {
            // No IDL known, or an error occurred, that's OK too
            specResult.rawidl = '';
          }
        }
        else {
          specResult.rawidl = await fs.readFile(path.resolve(
            config.crawlReports, query.crawl, 'idl',
            getShortname(studyResult || spec) + '.idl'), 'utf8');
        }
      }
      catch (err) {
        // No IDL known, that's OK too
        specResult.rawidl = '';
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
 * Fetches the requested report from memory storage, local file storage or
 * the network (with a refresh strategy based on the "crawlRefresh" parameter)
 *
 * @param  {String} crawlType  The crawl type ("w3c", "w3c-tr", "whatwg")
 * @param  {String} reportType The report to retrieve ("crawl" or "study")
 * @return {Promise(Object)} The promise to get the report's results
 */
async function fetchReport(crawlType, reportType) {
  let res = (crawlReports[crawlType] || {})[reportType];
  let now = Date.now();

  if (res && ((config.crawlRefresh === 'force') ||
    (Number.isInteger(config.crawlRefresh) &&
      (now - res.time > config.crawlRefresh * 1000)))) {
    res = null;
  }

  if (res) {
    return res.results;
  }

  if (config.crawlReports.startsWith('http:') ||
      config.crawlReports.startsWith('https:')) {
    let response = await fetch(
      `${config.crawlReports}${crawlType}/${reportType}.json`,
      { refresh: config.crawlRefresh }
    );
    res = await response.json();
  }
  else {
    res = requireFromWorkingDirectory(
      path.resolve(config.crawlReports, crawlType, `${reportType}.json`));
  }

  crawlReports[crawlType] = crawlReports[crawlType] || {};
  crawlReports[crawlType][reportType] = {
    time: now,
    results: res.results || []
  };
  return res.results || [];
}


/**
 * Flag set when the garbage collector is running
 *
 * @type {Boolean}
 */
let isGarbageCollectorRunning = false;


/**
 * Run the garbage collector on the query cache to make some room.
 *
 * @return {[type]} [description]
 */
async function garbageCollectQueryCache() {
  // Only run GC once at a time
  if (isGarbageCollectorRunning) {
    return;
  }
  isGarbageCollectorRunning = true;

  const files = await fs.readdir(config.queryCacheFolder);
  const stats = await Promise.all(files.map(async file => {
    const name = path.join(config.queryCacheFolder, file);
    try {
      const stat = await fs.stat(name);
      if (stat.isDirectory()) {
        return null;
      }
      return { name, atime: stat.atimeMs };
    }
    catch (err) {
      // File may have been dropped one way or the other
      return null;
    }
  }));

  // Sort files to put oldest accessed ones first
  const orderedStats = stats
    .filter(stat => !!stat)
    .sort((file1, file2) => file1.atime - file2.atime);

  // Remove 1/4 of entries in the query cache folder to make some room
  const maxToRemove = config.queryCacheMaxEntries / 4;
  let removed = 0;
  for (stat of orderedStats) {
    if (removed > config.queryCacheMaxEntries / 4) {
      break;
    }
    removed += 1;
    inQueryCache -= 1;
    try {
      await fs.unlink(stat.name);
    }
    catch(err) {
      console.warn(`Could not delete file ${stat.name} from cache`);
    }
  }

  isGarbageCollectorRunning = false;
}


/**
 * Search the crawl results in the query cache
 *
 * Note the query must contain the HTML of requested specs, otherwise we won't
 * use the cache (because there is no easy way to tell whether the contents of
 * the spec wouldn't have changed in the meantime)
 *
 * @param  {Object} query The query to search
 * @return {Promise<Object>} The promise to get crawl results from the query
 *   cache, or null if the results of the crawl are not in the query cache
 */
async function fetchCrawlResultsFromQueryCache(query) {
  if (query.specs.find(spec => !spec.html)) {
    return null;
  }
  if ((config.queryCacheRefresh === 'force') || (query.refresh === 'force')) {
    return null;
  }

  let hash = crypto.createHash('md5')
    .update(JSON.stringify(query.specs), 'utf8')
    .digest('hex');
  let cacheFilename = path.join(config.queryCacheFolder, hash + '.json');
  try {
    let now = Date.now();
    let stat = await fs.stat(cacheFilename);
    if (Number.isInteger(config.queryCacheRefresh) &&
        (now - stat.mtimeMs > config.queryCacheRefresh * 1000)) {
      return null;
    }

    let data = await fs.readFile(cacheFilename);
    let obj = JSON.parse(data, 'utf8');
    return obj;
  }
  catch (err) {
    return null;
  }
}


/**
 * Save the crawl results to the query cache
 *
 * See note in fetchCrawlResultsFromQueryCache about the need to have the HTML
 * of requested specs.
 *
 * @param  {Object} query The query for which we want to save results
 * @param  {Object} results The crawl results to save
 * @return {Promise} The promise to have saved the result (resolved when
 *   function is over, regardless of whether save was successful)
 */
async function saveCrawlResultsToQueryCache(query, results) {
  if (query.specs.find(spec => !spec.html)) {
    return;
  }

  // Time to run the garbage collector?
  // (will be done in parallel)
  inQueryCache += 1;
  if ((config.queryCacheMaxEntries >= 0) &&
      (inQueryCache > config.queryCacheMaxEntries)) {
    garbageCollectQueryCache();
  }

  let hash = crypto.createHash('md5')
    .update(JSON.stringify(query.specs), 'utf8')
    .digest('hex');
  let cacheFilename = path.join(config.queryCacheFolder, hash + '.json');
  await fs.writeFile(cacheFilename, JSON.stringify(results, null, 2), 'utf8');
  return;
}


/**
 * Processes a valid request to check specs against the latest known crawl
 * report.
 *
 * @param  {Object} query Valid query to process
 * @return {Promise(Object)} The promise to get a freshly baked anomalies report
 * for the specs in the query
 */
async function processCheckQuery(query, requestId) {
  // Load latest crawl report
  // console.time(`${requestId} - fetchReport`);
  let refCrawl = await fetchReport(query.crawl, 'crawl');
  // console.timeEnd(`${requestId} - fetchReport`);
  // console.time(`${requestId} - crawlList`);
  let crawlOptions = { publishedVersion: (query.crawl === 'w3c-tr') };
  let crawlResults = await fetchCrawlResultsFromQueryCache(query);
  if (!crawlResults) {
    crawlResults = await crawlList(query.specs, crawlOptions);
    saveCrawlResultsToQueryCache(query, crawlResults);
  }
  // console.timeEnd(`${requestId} - crawlList`);
  // console.time(`${requestId} - mergeCrawlResults`);
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
  // console.timeEnd(`${requestId} - mergeCrawlResults`);
  // console.time(`${requestId} - studyCrawl`);
  let study = studyCrawl(mergedCrawl, query.specs);
  // console.timeEnd(`${requestId} - studyCrawl`);

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
  let crawl = [];
  if (query.report.includes('crawl')) {
    crawl = await fetchReport(query.crawl, 'crawl');
  }

  // Load latest analysis if analysis info was requested or if IDL info was
  // requested (analysis info will help compute the shortname of the spec to
  // read the right IDL file)
  let study = [];
  if (query.report.includes('analysis') || query.report.includes('idl')) {
    study = await fetchReport(query.crawl, 'study');
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
    const requestId = counter;
    counter += 1;
    // console.time(`request ${requestId}`);
    prepareQueryFromHttpRequest(req)
      .then(validateQuery)
      .then(query => processFunction(query, requestId))
      .then(result => Object.assign({ status: 'ok' }, result))
      .then(result => res.json(result))
      .then(_ => next())
      .catch(err => next(err));
      // .then(_ => console.timeEnd(`request ${requestId}`));
  };
}


// Prettify JSON response to ease debugging in development mode
// (note these settings are not taken into account when NODE_ENV=production)
app.set('json spaces', 2);


// Set up the logger, compression, and body parser middlewares
monitor.install(app, { entries: config.entries });
app.use(compression());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json({ limit: '5mb' }));


///////////////////////////
// HTTP service endpoints
///////////////////////////
app.get('/check', getRequestMiddleware(processCheckQuery));
app.post('/check', getRequestMiddleware(processCheckQuery));
app.get('/specs', getRequestMiddleware(processSpecsQuery));
app.post('/specs', getRequestMiddleware(processSpecsQuery));

monitor.stats(app);

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
// Set fetch parameters
///////////////////////////

fetch.setParameter('cacheFolder', config.cacheFolder);
fetch.setParameter('logToConsole', config.logToConsole);
fetch.setParameter('refresh', config.cacheRefresh);


///////////////////////////
// Start the HTTP server
///////////////////////////

(async _ => {
  await checkQueryCacheFolder();

  app.listen(config.httpPort, (err) => {
    if (err) {
      console.error(err);
      process.exit(64);
    }
    console.log('Started');
  });
})();