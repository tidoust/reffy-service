# HTTP service for Reffy

[Reffy](https://github.com/tidoust/reffy) contains a set of tools to explore specs, including a crawler that creates a knowledge graph of specs, and a spec analysis tool that can point out potential anomalies in that graph. [Reffy reports](https://github.com/tidoust/reffy-reports) get published daily.

This repository exposes an HTTP service endpoint over Reffy that allows to:
1. retrieve the crawl and analysis results for a given spec.
2. crawl and analyse a given spec against the knowledge graph.

In both cases, the knowledge graph is the latest [published report](https://github.com/tidoust/reffy-reports).

The HTTP service is deployed as a beta tool in the W3C Labs at `https://labs.w3.org/reffy/`.


## Installation

1. Clone the repository
2. Run `npm install`
3. Create a `config.json` file in the root folder that contains a `w3cApiKey` valid [W3C API key](https://www.w3.org/users/myprofile/apikeys) (create one if needed, note you need to create a [W3C account](https://www.w3.org/accounts/request) first). That config file may contain other parameters, see below for details.
4. Start the HTTP server with `npm start`

By default, the HTTP service runs on port `3000`.


## Usage

### Operations

The HTTP service exposes two endpoints `/check` and `/specs`. These endpoints respond to `GET` and `POST` requests. At a minimum, each endpoint expects to receive the URL of a specification. When a `POST` request is used, the server expects to receive a JSON payload.

The server returns a JSON object that contains a `status` property set to `ok` when everything went fine and an optional `err` property that describes the error should one have occurred. In the absence of errors, the JSON object returned is indexed by requested URL.


#### Crawl and analyse a spec with `/check`

`POST https://labs.w3.org/reffy/check`

At a minimum, the expected JSON payload should be:

```json
{
  "url": "url of the spec to check",
  "html": "HTML content of the spec to check"
}
```

- The `url` parameter is needed to identify the specification in the knowledge graph. It should be the canonical URL for the underlying spec, typically the URL of the spec published in `/TR/` for W3C specs (e.g. `https://www.w3.org/TR/presentation-api/`).
- The `html` parameter contains the HTML content to check against the knowledge graph. For specs that are generated live with a JS editing tool such as [Respec](https://github.com/w3c/respec), this should be the generated HTML content, not the raw source.

See [Common query parameters](#common-query-parameters) below for additional parameters that may be specified.

If needed, multiple specs may be checked at once:

```json
{
  "specs": [
    {
      "url": "url of the first spec to check",
      "html": "HTML content of the first spec to check"
    },
    {
      "url": "url of the second spec to check",
      "html": "HTML content of the second spec to check"
    }
  ]
}
```

The server will:
1. parse and extract useful information from the HTML content provided (links, references, IDL)
2. complete that information with information from other sources ([W3C API](https://w3c.github.io/w3c-api/), [Specref](https://www.specref.org/))
3. merge the results of the first two step with the knowledge graph (generated daily)
4. analyse the knowledge graph to detect potential anomalies in the HTML content provided
5. return the result

Processing may take a few seconds. The server will cache the response for some time (defaults to one day) and return it for subsequent requests on the same URL and HTML content.

The endpoint is also available over `GET`, the endpoint expecting to receive the URL of the spec to check in a `url` parameter. The HTML content of the spec cannot be specified when a `GET` request. The server will fetch the latest Editor's Draft of the requested specification and run the same steps as above with the HTML content it retrieved. For instance, to check the latest version of the Presentation API, run:
```http
https://labs.w3.org/reffy/check?url=https://www.w3.org/TR/presentation-api/
```

**NB:** Use of the `GET` endpoint on the instance deployed on W3C labs is **strongly discouraged**, because the server cannot cache the answer (the HTML content of the spec may change at any time), and needs to run heavy processing each time. In particular, note the `GET` endpoint may be disabled at any time on the deployed instance.


#### Retrieve information about a spec with `/check`

`GET https://labs.w3.org/reffy/check`

Retrieve information about a spec from the knowledge graph. The endpoint expects a `url` parameter with the URL of the spec for which to retrieve information (or a comma-separated list of URLs).

For instance, to retrieve everything known about the Accelerometer and Magnetometer specs, run:
```http
https://labs.w3.org/reffy/specs?url=https://www.w3.org/TR/accelerometer,https://www.w3.org/TR/magnetometer&report=all
```


### Common query parameters

The following query parameters are common to all endpoints.


#### `crawl` to choose the crawl report

As explained on the [main page of published Reffy reports](https://tidoust.github.io/reffy-reports/), 3 reports get generated daily for now. Set the `crawl` parameter to force the crawl report to use. Value can be one of:

- `w3c`: report uses a W3C-centric perspective, preferring W3C specifications to WHATWG specifications when both exist. Latest Editor's Drafts of specifications are crawled. This is the default value.
- `w3c-tr`: report uses the same W3C-centric perspective as above, but latest published version of specifications (in `/TR/`) are crawled.
- `whatwg`: use a WHATWG-centric perspective, preferring WHATWG specifications to W3C specifications when both exist.

Hopefully, the `w3c` and `whatwg` perspectives will align longer term, leaving only two values to choose from. The `w3c-tr` report should typically be used to check a spec when it is about to be published in `/TR/`. It will point out anomalies in dependencies such as "the spec defines an IDL term that is not defined in any published spec for now". The `w3c` and `whatwg` reports should be used to check Editor's Drafts.


#### `report` to choose the information to return

By default, the server will return the result of the analysis, along with a few useful information about the spec, such as the spec's title, the URL of the Editor's Draft, the URL of the repository that contains the source of the spec, and the date of the spec that was crawled.

Use the `report` parameter to change/complete that information. Value should either set to `all` to request all possible information or be a comma-separated list of the following tokens:
- `analysis`: returns the result of running an analysis on the spec. The analysis appears in a `report` property in the response. This is the default value.
- `crawl`: returns the information gathered during crawl, such as the list of references to other specs (in a `refs` property), the list of links (in a `links` property) and the parsed IDL tree (in an `idl` property).
- `idl`: returns the raw IDL extracted from the spec (in a `rawidl` property).


#### `refresh` to force a refresh

Set the `refresh` parameter to `force` in `POST` requests to the `/check` endpoint to force the server to refresh its cache. To be used with parsimony on the deployed instance.


## Configuration

| Setting | Description | Default value |
|:-------:| ----------- | -------------:|
| `cacheFolder` | Cache folder | `.cache` |
| `cacheRefresh` | Cache refresh strategy for specs to check. Defaults to forcing a new fetch request each time as people usually want to check the latest version of a spec, and not a cached version that could already be obsolete. Possible values defined in the [`fetch-filecache-for-crawling` library](https://github.com/tidoust/fetch-filecache-for-crawling#configuration) | `force` |
| `crawlRefresh` | Cache refresh strategy for crawl reports. Defaults to refreshing the contents of the cache after 1/2 day for crawls. Possible values defined in the [`fetch-filecache-for-crawling` library](https://github.com/tidoust/fetch-filecache-for-crawling#configuration) | `43200` |
| `crawlReports` | Where to get the crawl reports from. HTTP URL or path to local file | `https://tidoust.github.io/reffy-reports/` |
| `httpPort` | HTTP port number for the service | `3000` |
| `queryCacheFolder` | Query cache folder (contains results of individual crawls) | `.querycache` |
| `queryCacheRefresh` | Cache refresh strategy for query checks. Defaults to refreshing the contents of the cache after one day. Possible values are `force` (which means the cache will never be used), `never` (which means cache entries will always be considered to be valid), or an integer (number of seconds before expiration). | `86400` |
| `queryCacheMaxEntries` | Maximum number of entries to keep in the query cache folder (soft limit, garbage collection may take some time). Set the parameter to `-1` to disable garbage collection. | `10000` |
| `logToConsole` | Whether to output additional execution traces to the console. Should only be set in debug mode | `false` |
| `w3cApiKey` | The W3C API key to use to send requests to the W3C API | `null` |
