[![New Relic Experimental header](https://github.com/newrelic/opensource-website/raw/master/src/images/categories/Experimental.png)](https://opensource.newrelic.com/oss-category/#new-relic-experimental)

# New Relic Outdated Agents Reporting

Capability to determine and report on outdated agents across New Relic. Consists of 2 solutions:

1. Synthetic API Scripted Monitor that fetches, aggregates, and reports outdated agents to a custom eventType - `OutdatedAgents`
2. Workflow automation templates to periodically send out email report(s) (attached csv(s)) containing the results of querying the events emitted by the Synthetic script.

**NOTE: An alternative solution to workflow automation is [Scheduled NRQL Searches](https://docs.newrelic.com/docs/nrql/using-nrql/schedule-nrql-searches/). Skip workflow template sections below if using this feature. This feature is preferred over workflow automation**

## Pre-requirements

### Synthetic Script
 - Fill in Configuration section of [outdated_agents.js](/outdated_agents.js)

#### Configuration
 - A valid ingest key (to the account in which data will be reported to) **NOTE: This should be added as a secure credential**
 - A valid user key (that has access to query data across all accounts) **NOTE: This should be added as a secure credential**
 - Account ID (that ingest key was generated within)
 - Comment/uncommment sections of the desired `AGENTS` to collect outdated agents for
 - Add/remove `TAGS_TO_INCLUDE` - entity tags that will be fetched and appended to final output
 - Adjust `ENTITY_SEARCH_FILTER` to target specific entities based on tags, name, etc to determine outdated agents against

### Workflow Template
- Synthetic script is deployed, configured, and successfully sending data to New Relic.
- An email destination configured with desired email addresses to recieve report(s).

#### Configuration

Required Inputs:
- **emailDestinationId** - The ID of the email destination that contains recipients of the report. This can be found for a given destination on the destinations page under **Alerts**
- **accountId** - The account in which the data being queried is reporting to
- **nrql** - This only applies to [outdated_agents_single_nrql](./templates/outdated_agents_single_nrql.yaml). This is the query that fetches all details across all agentTypes

## Installation

### Synthetic Script
Configure the script per the pre-requirements and [Follow the docs here](https://docs.newrelic.com/docs/synthetics/synthetic-monitoring/using-monitors/add-edit-monitors/#complex)

**NOTE: it is recommended to run the script daily and from a single location**

Once script is deployed, data can be explored by querying `OutdatedAgents` via NRQL:

```
SELECT * FROM OutdatedAgents
```

### Workflow Template
There are several variations of a workflow template located under `../templates`. Choose one to deploy based on the amount of entities in your estate:

- **> 5k**: [outdated_agents_multiple_nrql.yaml](./templates/outdated_agents_multiple_nrql.yaml) - Add/remove agent blocks depending on what agent types you want to obtain reports for. Fetches a single agent type per nrql query.
- **< 5k**: [outdated_agents_single_nrql.yaml](/templates/outdated_agents_single_nrql.yaml) - Will fetch all agent types in a single query.

To deploy one of these templates, follow the steps below, or if you want to automate deployment, see [API documentation here](https://docs.newrelic.com/docs/workflow-automation/workflow-automation-apis/create-workflow-definition/)

1. Navigate to New Relic -> Workflow Automation UI
2. Select `Create your own` button at the top right
3. Select the code view (`</>` icon at the bottom of the editor)
4. Copy/paste your configured yaml into the text space (**NOTE: it is expected to fine tune or configure the workflowInputs, name, etc per your preferences before saving**)
5. Select `Update Canvas`
6. Select `Save`

You can now run and [schedule the workflow](https://docs.newrelic.com/docs/workflow-automation/create-a-workflow-automation/start-schedule/#scheduled) to periodically send out an email report to a defined alert destination. Below is an example for scheduling one of the base templates daily at noon eastern time:

```
mutation {
  workflowAutomationCreateSchedule(
    scope: {type: ACCOUNT, id: "1"}
    definition: {name: "outdated_agents_multiple_nrql", version: 1}
    workflowInputs: [{key: "emailDestinationId", value: "abc-1234-efg-567-xyz"}, {key: "accountId", value: "1"}]
    timezone: "America/New_York"
    cronExpression: "0 12 * * *"
  ) {
    scheduleId
  }
}
```


## Limitations
- Each step output in a workflow automation template cannot exceed 100kb. If any workflow run errors occur related to this limit, adjust the provided base templates as needed (steps, nrql queries, etc) to fit your use cases/amount of entities.
- The 5k NRQL row limit still applies to scheduled searches. If your query against `OutdatedAgents` returns more than 5,000 rows, create multiple scheduled searches with finer grained nrql query filters.

## Support

<a href="https://github.com/newrelic?q=nrlabs-viz&amp;type=all&amp;language=&amp;sort="><img src="https://user-images.githubusercontent.com/1786630/214122263-7a5795f6-f4e3-4aa0-b3f5-2f27aff16098.png" height=50 /></a>

This project is actively maintained by the New Relic Labs team. Connect with us directly by [creating issues](../../issues) or [asking questions in the discussions section](../../discussions) of this repo.

We also encourage you to bring your experiences and questions to the [Explorers Hub](https://discuss.newrelic.com) where our community members collaborate on solutions and new ideas.

New Relic has open-sourced this project, which is provided AS-IS WITHOUT WARRANTY OR DEDICATED SUPPORT.

## Security

As noted in our [security policy](https://github.com/newrelic/nr-labs-pages/security/policy), New Relic is committed to the privacy and security of our customers and their data. We believe that providing coordinated disclosure by security researchers and engaging with the security community are important means to achieve our security goals.

If you believe you have found a security vulnerability in this project or any of New Relic's products or websites, we welcome and greatly appreciate you reporting it to New Relic through [HackerOne](https://hackerone.com/newrelic).

## Open Source License

This project is distributed under the [Apache 2 license](LICENSE).