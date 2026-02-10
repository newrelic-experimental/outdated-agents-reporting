const got = require('got');
const async = require('async');
const zlib = require('zlib');

/* --------------------------------------------------------- */
  // Author: Keagan Peet <kpeet@newrelic.com>
  // Description: Aggregate outdated agent versions across various domains and report as custom events back to New Relic
  // Type: Scripted API Synthetic Monitor
/* --------------------------------------------------------- */

/* -------------------CONFIGURATION----------------- */
const USER_KEY = "<user key>"; // User key to fetch data via GraphQL (NOTE: make this a secure credential in Synthetics)
const INGEST_KEY = "<ingest key>"; // Ingest key to write events to NR (NOTE: make this a secure credential in Synthetics)
const ACCOUNT_ID = 1; // Account ID to report events to

// list of agents to check for outdated versions, comment out specific lines to exclude certain agents from the check
const AGENTS = [
    {agentName: "DOTNET", domain: "APM"},
    {agentName: "GO", domain: "APM"},
    {agentName: "JAVA", domain: "APM"},
    {agentName: "NODEJS", domain: "APM"},
    {agentName: "PHP", domain: "APM"},
    {agentName: "PYTHON", domain: "APM"},
    {agentName: "RUBY", domain: "APM"}, 
    {agentName: "INFRASTRUCTURE", domain: "INFRA"},
    {agentName: "BROWSER", domain: "BROWSER"},
    {agentName: "IOS", domain: "MOBILE"},
    {agentName: "ANDROID", domain: "MOBILE"},
];
const TAGS_TO_INCLUDE = ["language", "team"]; // entity tags to include in dataset

const ENTITY_SEARCH_FILTER = "reporting is true"; // base filter for entity fetching - accepts any valid entitySearch filter
/* ------------------------------------------------ */


// Constants [DO NOT CHANGE]
const GRAPH_API = 'https://api.newrelic.com/graphql';
const HEADERS = { 'Content-Type': 'application/json', 'Api-Key': USER_KEY };
const EVENT_TYPE = "OutdatedAgents";
const MAX_CONCURRENCY = 25;

async function main() {
    let agentVersions = [];

    const agentVersionQueue = async.queue((task, cb) => {
        getAgentVersions(task.agent).then(aResult => {
            cb(null, aResult);
        }).catch(err => {
            cb(err);
        });
    }, MAX_CONCURRENCY);

    const agentVersionPromise = new Promise(resolve => {
        agentVersionQueue.drain(() => {
            resolve(agentVersions);
        });
    });

    for (const agent of AGENTS) {
        agentVersionQueue.push({ agent: agent }, (err, result) => {
            if (err) {
                console.error(`Error fetching versions for agent ${agent.agentName}:`, err);
                return;
            }
            agentVersions.push(result);
        });
    }

    // Fetch all agent versions
    const allVersions = await agentVersionPromise;
    const allVersionsFlat = allVersions.flat();

    // Get the most recent version for each unique agentName
    const latestAgentVersions = Object.values(
        allVersionsFlat.reduce((acc, v) => {
            if (!acc[v.agentName] || new Date(v.date) > new Date(acc[v.agentName].date)) {
                acc[v.agentName] = v;
            }
            return acc;
        }, {})
    );

    // Fetch entities for each domain in parallel
    const domains = [...new Set(AGENTS.map(a => a.domain))];
    const domainResults = await Promise.all(
        domains.map(domain => getEntities(null, [], domain))
    );
    let entitiesWithVersions = domainResults.flat();

    // if mobile domain is present in AGENTS, extract mobile entities for separate version lookup
    const hasMobileDomain = AGENTS.some(a => a.domain === 'MOBILE');
    if (hasMobileDomain) {
        const hasIOS = AGENTS.some(a => a.agentName === 'IOS');
        const hasAndroid = AGENTS.some(a => a.agentName === 'ANDROID');
        
        // Extract mobile entities and remove them from main array
        const mobileEntities = entitiesWithVersions.filter(e => e.domain === 'MOBILE');
        entitiesWithVersions = entitiesWithVersions.filter(e => e.domain !== 'MOBILE');
        
        // Get versions for mobile entities and merge back into main array
        const mobileEntitiesWithVersions = await getMobileAgentVersions(mobileEntities, hasIOS, hasAndroid);
        entitiesWithVersions = entitiesWithVersions.concat(mobileEntitiesWithVersions);
    }
    
    const outdated = processData(entitiesWithVersions, allVersionsFlat, latestAgentVersions);

    if (outdated && outdated.length > 0) {
      await writeResultsToNR(outdated);  
    } else {
        console.log('No outdated agents found. No results written to New Relic');
    }
}


// Fetch the latest agent version for a given agent
async function getAgentVersions(agent) {
  const currentAgentVersionQ = `{ docs { agentReleases(agentName: ${agent.agentName}) { version date } } }`;
  const opts = {
    url: GRAPH_API,
    headers: HEADERS,
    json: {'query': currentAgentVersionQ, 'variables': {}}
  };

  const resp = await got.post(opts).json();
  if (resp.errors) {
    throw new Error(`GraphQL error for ${agent.agentName}: ${JSON.stringify(resp.errors)}`);
  }
  

  let versionResult = [];
  for (const v of resp.data?.docs.agentReleases) {
    versionResult.push({agentName: agent.agentName, domain: agent.domain, version: v?.version, date: v?.date});
  }
  return versionResult;
};

// Fetch entities for a given domain, handling pagination
async function getEntities(cursor = null, all = [], domain) {
    const searchFilter = _buildEntitySearchFilter(domain);
    
    const entityQuery = `
    {
        actor {
            entitySearch(query: "${searchFilter}") {
            results${cursor == null ? '' : `(cursor: "${cursor}")`} {
                entities {
                account {
                    id
                    name
                }
                name
                guid
                tags {
                    key
                    values
                }
                domain
                ... on BrowserApplicationEntityOutline {
                    runningAgentVersions {
                      maxVersion
                      minVersion
                    }
                }
               }
              nextCursor
            }
          }
        }
    }
    `;

  const opts = {
    url: GRAPH_API,
    headers: HEADERS,
    json: {'query': entityQuery, 'variables': {}}
  };

  let resp = await got.post(opts).json();
  if (resp.errors) {
    console.log(JSON.stringify(resp.errors));
    throw new Error('Failed to fetch entities');
  } else {
    let someEntities = resp.data.actor.entitySearch.results.entities;
    let nextCursor = resp.data.actor.entitySearch.results.nextCursor;

    if (nextCursor == null) {
      all = all.concat(someEntities);
      return all;
    } else {
      all = all.concat(someEntities);
      return getEntities(nextCursor, all, domain);
    }
  }
};

// Build the entity search filter for a given domain
function _buildEntitySearchFilter(domain) {    
    const filterParts = [ENTITY_SEARCH_FILTER];
    
    // Add domain filter
    if (domain) {
        filterParts.push(`domain = '${domain}'`);
    }

    // Infra domain includes containers, k8s, aws entities - we only want hosts with agents.
    if (domain === 'INFRA') {
        filterParts.push(`type = 'HOST'`);
    }

    // APM language filters (only apply if domain is APM)
    if (domain === 'APM') {
        const apmAgents = AGENTS.filter(a => a.domain === 'APM');
        if (apmAgents.length > 0) {
            const languageList = apmAgents.map(a => `'${a.agentName.toLowerCase()}'`).join(', ');
            filterParts.push(`tags.language in (${languageList})`);
        }
    }
    
    return filterParts.join(' AND ');
}

// pluck a tag value from an array of tags
const _pluckTagValue = (tags, keyToPluck) => {
  const result = tags.find(t => t.key === keyToPluck);
  return result ? result.values[0] : null;
};

// append versions to associated mobileEntities -> return mobileEntities -> put those back into the main entities array
async function getMobileAgentVersions(mobileEntities, hasIOS, hasAndroid) {
    const iOSFilter = "where newRelicAgent = 'iOSAgent'";
    const androidFilter = "where newRelicAgent = 'AndroidAgent'";
    const combinedFilter = "where newRelicAgent IN ('iOSAgent', 'AndroidAgent')";

    // Determine filter based on flags
    const filter = hasIOS && hasAndroid ? combinedFilter
                 : hasIOS ? iOSFilter
                 : hasAndroid ? androidFilter
                 : '';

    const nrql = `SELECT latest(newRelicVersion) as 'agentVersion' FROM Mobile ${filter} FACET entityGuid as 'guid' LIMIT MAX SINCE 1 day ago`;

    // Get unique account IDs from mobileEntities and chunk into arrays of 5
    const uniqueAccounts = [...new Set(mobileEntities.map(e => e.account.id))];
    const accountChunks = [];
    for (let i = 0; i < uniqueAccounts.length; i += 5) {
        accountChunks.push(uniqueAccounts.slice(i, i + 5));
    }

    // Build dynamic nrql query aliases for each chunk of accounts
    const nrqlQueries = accountChunks.map((chunk, i) => 
        `mobileAgentVersions_set${i}: nrql(accounts: [${chunk.join(',')}], query: "${nrql}", timeout: 120) {results}`
    ).join('\n        ');

    const gql = `
    {
      actor {
        ${nrqlQueries}
      }
    }`;

    const opts = {
      url: GRAPH_API,
      headers: HEADERS,
      json: {'query': gql, 'variables':{}}
    };

    let resp = await got.post(opts).json();
    if (resp.errors) {
        console.log(JSON.stringify(resp.errors));
        throw new Error('Failed to fetch mobile agent versions');
    }

    // Flatten results from all sets into a single array
    const flattened = Object.values(resp.data.actor).flatMap(set => set.results);
    
    // Map agentVersion back to each corresponding entity in mobileEntities by matching guid
    // Entities with null agentVersion will be filtered out
    const versionMap = new Map(flattened.map(r => [r.guid, r.agentVersion]));
    return mobileEntities
        .map(e => ({
            ...e,
            agentVersion: versionMap.get(e.guid) || null
        }))
        .filter(e => e.agentVersion !== null);
}

// Compare each entity's current version with the latest agent version to determine outdated agents
function processData(entities, agentVersions, latestVersions) {
    let outdatedAgents = [];
    for (const entity of entities) {
        let currentVersion  = _pluckTagValue(entity.tags, 'agentVersion');
        let latestVersion = latestVersions.find(v => v.domain === entity.domain);
        if (entity.domain === 'MOBILE') {
            currentVersion = entity.agentVersion;
        }

        if (entity.domain === 'BROWSER') {
            currentVersion = _convertBrowserVersionToSemver(entity.runningAgentVersions?.maxVersion);
        }

        if (_isVersionOutdated(currentVersion, latestVersion?.version)) {
            let currentVersionDetail = agentVersions.find(v => v.domain === entity.domain && v.version === currentVersion);

            let anOutdatedAgent = {
                eventType: EVENT_TYPE,
                accountName: entity.account.name || null,
                account_id: entity.account.id || null,
                domain: entity.domain || null,
                agentType: currentVersionDetail?.agentName,
                entityName: entity.name || null,
                entityGuid: entity.guid || null,
                currentVersion: currentVersion || null,
                currentVersionReleaseDate: currentVersionDetail?.date || null,
                currentVersionAgeInDays: Math.floor((new Date() - new Date(currentVersionDetail?.date)) / 86400000) || null,
                latestVersion: latestVersion?.version || null,
                latestVersionReleaseDate: latestVersion?.date || null
            };

            if (TAGS_TO_INCLUDE.length > 0) {
                for (const tag of TAGS_TO_INCLUDE) {
                    anOutdatedAgent[tag] = _pluckTagValue(entity.tags, tag);
                }
            }
            outdatedAgents.push(anOutdatedAgent);
        }
    }
    return outdatedAgents;
};

// Convert BROWSER version from whole number to version string
// Versions <= 1227 use plain number format ("1216"), versions > 1227 use semver ("1.308.0")
const _convertBrowserVersionToSemver = (versionNum) => {
    if (!versionNum) return null;
    const num = typeof versionNum === 'number' ? versionNum : parseInt(versionNum, 10);
    
    // Versions 1227 and earlier use plain number format
    if (num <= 1227) {
        return num.toString();
    }
    
    // Versions after 1227 use semver format: 1308 -> "1.308.0"
    const versionStr = num.toString();
    const major = versionStr[0];
    const minor = versionStr.substring(1);
    return `${major}.${minor}.0`;
};

// Compare two version strings to determine if the current version is outdated
const _isVersionOutdated = (currentVersion, latestVersion) => {
    if (!currentVersion || !latestVersion) return false;
    
    const currentStr = currentVersion.toString();
    const latestStr = latestVersion.toString();
    
    // Handle BROWSER version format mismatch: old format (no dots) vs new format (with dots)
    // Old format versions (<=1227) are always outdated compared to new semver format
    const currentHasDots = currentStr.includes('.');
    const latestHasDots = latestStr.includes('.');
    if (!currentHasDots && latestHasDots) {
        return true; // Old format is always outdated vs new semver format
    }
    if (currentHasDots && !latestHasDots) {
        return false; // New format is never outdated vs old format
    }
    
    // Same format comparison (either both old or both new)
    const currentParts = currentStr.split('.').map(Number);
    const latestParts = latestStr.split('.').map(Number);
    for (let i = 0; i < Math.max(currentParts.length, latestParts.length); i++) {
        const currentPart = currentParts[i] || 0;
        const latestPart = latestParts[i] || 0;
        if (currentPart < latestPart) return true;
        if (currentPart > latestPart) return false;
    }
    return false;
}

const _compressData = data => {
  return new Promise((resolve, reject) => {
    zlib.gzip(JSON.stringify(data), null, function(err, compressed) {
      if (!err) {
        resolve(compressed);
      } else {
        console.log('Failed to compress payload.');
        console.log(err);
        reject('error');
      }
    })
  })
}

// Write the results of outdated agents to New Relic as events
async function writeResultsToNR(outdatedAgents) {
  var h = {
    'Content-Type': 'application/json',
    'X-Insert-Key': INGEST_KEY,
    'Content-Encoding': 'gzip'
  };

  var opts = {
    url: `https://insights-collector.newrelic.com/v1/accounts/${ACCOUNT_ID.toString()}/events`,
    headers: h,
    body: await _compressData(outdatedAgents)
  };

  let resp = await got.post(opts);
  if (resp.statusCode == 200) {
    console.log('Successfully posted outdated agents to NRDB');
  } else {
    console.log('Error posting to NRDB ' + resp.statusCode);
    console.log(resp.body);
    throw new Error('Failed to post to NRDB');
  }
};

main();