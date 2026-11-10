#!/usr/bin/env node
// Generates the Talon Grafana dashboards into infra/grafana/dashboards/.
// Run after editing: node infra/grafana/build-dashboards.mjs
// (Grafana picks up changed files within 10 seconds.)
//
// Dashboards and how they link:
//   talon-overview  status of the whole system; every panel drills down
//   talon-web       one web server: metrics, nginx and backend logs
//   talon-running   jobs running or queued now, live (refreshes every 30 s)
//   talon-job       one job: database row, ledger, machine metrics, logs
//   talon-student   one student: balance, jobs, ledger, classes
//   talon-request   one request id: backend and nginx lines
//
// AWS resources are found by tag (Project=talon, Environment=$env), so no
// account ids or resource ids are written here (the repo is public).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "dashboards");

const CW = { type: "cloudwatch", uid: "talon-cloudwatch" };
const PG = { type: "grafana-postgresql-datasource", uid: "talon-postgres" };
const LOG = (name) => `/talon/$env/${name}`;

// ---- queries ----------------------------------------------------------------

const refIds = "ABCDEFGHIJ";

function cw(namespace, metricName, dimensions, statistic, label = "") {
  return {
    datasource: CW, queryMode: "Metrics", metricQueryType: 0, metricEditorMode: 0, region: "default",
    namespace, metricName, dimensions, statistic, period: "", matchExact: true, label, id: "", expression: "",
  };
}

// statsGroups: the "by" fields (other than bin) that split a stats query into series.
function logs(groups, expression, statsGroups = []) {
  return { datasource: CW, queryMode: "Logs", region: "default", id: "", expression: expression.trim(), logGroupNames: groups, statsGroups };
}

function sql(rawSql, format = "table") {
  return { datasource: PG, editorMode: "code", rawQuery: true, format, rawSql: rawSql.trim() };
}

// ---- panels -----------------------------------------------------------------

function panel(type, title, gridPos, targets, extra = {}) {
  const ds = targets[0]?.datasource;
  return {
    type, title, gridPos, datasource: ds,
    targets: targets.map((t, i) => ({ refId: refIds[i], ...t })),
    ...extra,
  };
}

function stat(title, gridPos, targets, { unit = "short", decimals, thresholds, description, links, textMode = "value_and_name", calc = "lastNotNull", colorMode = "value" } = {}) {
  return panel("stat", title, gridPos, targets, {
    description,
    options: { reduceOptions: { calcs: [calc], fields: "", values: false }, textMode, colorMode, graphMode: "area", justifyMode: "auto", orientation: "auto" },
    fieldConfig: {
      defaults: {
        unit, decimals, links: links || [],
        color: { mode: "thresholds" },
        thresholds: { mode: "absolute", steps: thresholds || [{ color: "green", value: null }] },
      },
      overrides: [],
    },
  });
}

function timeseries(title, gridPos, targets, { unit = "short", bars = false, stack = false, links, description, min } = {}) {
  return panel("timeseries", title, gridPos, targets, {
    description,
    options: { legend: { displayMode: "list", placement: "bottom", showLegend: true }, tooltip: { mode: "multi", sort: "desc" } },
    fieldConfig: {
      defaults: {
        unit, min, links: links || [],
        custom: {
          drawStyle: bars ? "bars" : "line", lineWidth: 1, fillOpacity: bars ? 80 : 10, showPoints: "never",
          spanNulls: false, stacking: { mode: stack ? "normal" : "none", group: "A" },
        },
      },
      overrides: [],
    },
  });
}

// columns: { fieldName: { link, unit, width, hidden, displayName } }
function table(title, gridPos, targets, { columns = {}, description, sortBy } = {}) {
  const overrides = Object.entries(columns).map(([name, c]) => ({
    matcher: { id: "byName", options: name },
    properties: [
      c.link && { id: "links", value: [{ title: c.link.title, url: c.link.url }] },
      c.unit && { id: "unit", value: c.unit },
      c.width && { id: "custom.width", value: c.width },
      c.hidden && { id: "custom.hidden", value: true },
      c.displayName && { id: "displayName", value: c.displayName },
    ].filter(Boolean),
  }));
  return panel("table", title, gridPos, targets, {
    description,
    options: { showHeader: true, cellHeight: "sm", footer: { show: false }, sortBy: sortBy || [] },
    fieldConfig: { defaults: { custom: { align: "auto", filterable: true } }, overrides },
  });
}

function barchart(title, gridPos, targets, { unit = "short", description } = {}) {
  return panel("barchart", title, gridPos, targets, {
    description,
    options: { orientation: "horizontal", showValue: "auto", legend: { showLegend: false }, xTickLabelRotation: 0 },
    fieldConfig: { defaults: { unit, color: { mode: "palette-classic" } }, overrides: [] },
  });
}

function logsPanel(title, gridPos, targets, description) {
  return panel("logs", title, gridPos, targets, {
    description,
    options: { showTime: true, wrapLogMessage: true, sortOrder: "Ascending", enableLogDetails: true, dedupStrategy: "none" },
  });
}

function row(title, y) {
  return { type: "row", title, collapsed: false, gridPos: { h: 1, w: 24, x: 0, y }, panels: [] };
}

const g = (x, y, w, h) => ({ x, y, w, h });

// ---- variables --------------------------------------------------------------

const envVar = {
  name: "env", label: "Environment", type: "custom", query: "demo",
  current: { text: "demo", value: "demo" }, options: [{ text: "demo", value: "demo", selected: true }], hide: 0,
};

// A tagged AWS resource's ARN, cut down to the id CloudWatch uses as its dimension.
function arnVar(name, label, resourceType, regex, { multi = false } = {}) {
  return {
    name, label, type: "query", datasource: CW, hide: 0, refresh: 1, regex, sort: 1,
    multi, includeAll: multi, current: {},
    query: {
      refId: "VariableQueryEditor-VariableQuery", queryType: "resourceARNs", region: "default",
      resourceType, tags: { Project: ["talon"], Environment: ["$env"] },
    },
  };
}

const albVar = arnVar("alb", "Load balancer", "elasticloadbalancing:loadbalancer", "/:loadbalancer\\/(app\\/.+)$/");
const tgVar = arnVar("tg", "Target group", "elasticloadbalancing:targetgroup", "/:(targetgroup\\/.+)$/");
const rdsVar = arnVar("rds", "Database", "rds:db", "/:db:(.+)$/");
const natVar = arnVar("nat", "NAT gateways", "ec2:natgateway", "/natgateway\\/(.+)$/", { multi: true });

function webVar({ multi }) {
  return {
    name: multi ? "web" : "instance", label: "Web server", type: "query", datasource: CW, hide: 0, refresh: 2, sort: 1,
    multi, includeAll: multi, current: {},
    query: {
      refId: "VariableQueryEditor-VariableQuery", queryType: "ec2InstanceAttributes", region: "default",
      attributeName: "InstanceId",
      ec2Filters: { "tag:Project": ["talon"], "tag:Component": ["web"], "tag:Environment": ["$env"], "instance-state-name": ["running"] },
    },
  };
}

function pgVar(name, label, query, { hide = 0 } = {}) {
  return { name, label, type: "query", datasource: PG, hide, refresh: 1, sort: 0, query, definition: query, current: {}, multi: false, includeAll: false };
}

// A multi-select over a database column, "All" by default, re-queried on every
// refresh (time range change) so it follows jobs as they start and finish.
const pgMultiVar = (name, label, query) => ({
  name, label, type: "query", datasource: PG, hide: 0, refresh: 2, sort: 1, query, definition: query,
  multi: true, includeAll: true, current: { text: "All", value: "$__all" },
});

const textVar = (name, label) => ({ name, label, type: "textbox", query: "", current: { text: "", value: "" }, hide: 0 });

// ---- links ------------------------------------------------------------------

const T = "${__url_time_range}";
const linkJob = (field = "${__value.raw}") => ({ title: "Open job", url: `/d/talon-job/talon-job?var-env=$env&var-job_id=${field}&from=\${__data.fields.start_ms}&to=\${__data.fields.end_ms}` });
const linkJobKeepTime = { title: "Open job", url: `/d/talon-job/talon-job?var-env=$env&var-job_id=\${__value.raw}&${T}` };
const linkStudent = { title: "Open student", url: `/d/talon-student/talon-student?var-env=$env&var-student=\${__value.raw}&${T}` };
const linkWeb = { title: "Open web server ${__field.labels.InstanceId}", url: `/d/talon-web/talon-web?var-env=$env&var-instance=\${__field.labels.InstanceId}&${T}` };
const linkWebCell = { title: "Open web server", url: `/d/talon-web/talon-web?var-env=$env&var-instance=\${__value.raw}&${T}` };
const linkRequest = { title: "Trace request", url: `/d/talon-request/talon-request?var-env=$env&var-request_id=\${__value.raw}&${T}` };

// Cost panels count EC2 jobs only. Local runs are free; the demo seed gives
// its fake history "local" jobs with made-up costs (seedDemo.js) so student
// budgets look used, and those are not AWS spend.
const EC2 = "provider = 'ec2'";

// Hidden columns that give a job link its time window (start - 10 min .. end + 10 min).
const JOB_WINDOW = `
  (extract(epoch FROM created_at - interval '10 minutes') * 1000)::bigint AS start_ms,
  (extract(epoch FROM coalesce(finalized_at, now()) + interval '10 minutes') * 1000)::bigint AS end_ms`;
const jobColumns = {
  job: { link: linkJob(), width: 110 },
  student: { link: linkStudent },
  start_ms: { hidden: true },
  end_ms: { hidden: true },
  cost: { unit: "currencyUSD" },
  reserved: { unit: "currencyUSD" },
  duration: { unit: "s" },
  instance: { width: 180 },
};

function dashboard(uid, title, { panels, variables, time = "now-6h", refresh = "1m", description }) {
  return {
    uid, title, description, tags: ["talon"], editable: true, schemaVersion: 41, version: 1,
    time: { from: time, to: "now" }, refresh, timezone: "browser", graphTooltip: 1,
    templating: { list: variables },
    links: [{ title: "Talon", type: "dashboards", tags: ["talon"], asDropdown: true, includeVars: false, keepTime: true }],
    panels: panels.map((p, i) => ({ id: i + 1, ...p })),
  };
}

// ---- talon-overview -----------------------------------------------------------

const ALB = { LoadBalancer: "$alb" };
const RDS = { DBInstanceIdentifier: "$rds" };
const WEB = { InstanceId: "$web" };
const ELB = "AWS/ApplicationELB";

const overview = dashboard("talon-overview", "Talon overview", {
  description: "Status of the whole Talon system. Click a server, job, student or request id to drill down.",
  variables: [envVar, albVar, tgVar, rdsVar, natVar, webVar({ multi: true })],
  panels: [
    row("Status", 0),
    stat("Healthy web servers", g(0, 1, 3, 4), [cw(ELB, "HealthyHostCount", { ...ALB, TargetGroup: "$tg" }, "Minimum")],
      { thresholds: [{ color: "red", value: null }, { color: "orange", value: 1 }, { color: "green", value: 2 }], textMode: "value", description: "Minimum healthy targets behind the ALB (2 expected)." }),
    stat("5xx errors", g(3, 1, 3, 4), [cw(ELB, "HTTPCode_ELB_5XX_Count", ALB, "Sum", "ALB"), cw(ELB, "HTTPCode_Target_5XX_Count", ALB, "Sum", "app")],
      { calc: "sum", thresholds: [{ color: "green", value: null }, { color: "red", value: 1 }], description: "In the time range. ALB = gateway errors and timeouts; app = the backend answered 5xx." }),
    stat("Response time p95", g(6, 1, 3, 4), [cw(ELB, "TargetResponseTime", ALB, "p95")],
      { unit: "s", decimals: 2, textMode: "value", thresholds: [{ color: "green", value: null }, { color: "orange", value: 1 }, { color: "red", value: 5 }] }),
    stat("Database CPU", g(9, 1, 3, 4), [cw("AWS/RDS", "CPUUtilization", RDS, "Average")],
      { unit: "percent", decimals: 0, textMode: "value", thresholds: [{ color: "green", value: null }, { color: "orange", value: 60 }, { color: "red", value: 85 }] }),
    stat("Database connections", g(12, 1, 3, 4), [cw("AWS/RDS", "DatabaseConnections", RDS, "Maximum")], { textMode: "value" }),
    stat("Jobs now", g(15, 1, 3, 4), [sql(`
      SELECT count(*) FILTER (WHERE status = 'running') AS running,
             count(*) FILTER (WHERE status = 'queued')  AS queued,
             count(*) FILTER (WHERE status = 'running' AND compute_type ~ '^g') AS "on GPU"
      FROM reporting.jobs`)], {
      description: "From the database (talon_grafana, reporting.jobs). Click for the running-jobs dashboard.",
      links: [{ title: "Running jobs", url: "/d/talon-running/talon-running?var-env=$env" }],
    }),
    stat("vCPUs in use (account)", g(18, 1, 3, 4), [
      cw("AWS/Usage", "ResourceCount", { Service: "EC2", Type: "Resource", Resource: "vCPU", Class: "Standard/OnDemand" }, "Maximum", "standard"),
      cw("AWS/Usage", "ResourceCount", { Service: "EC2", Type: "Resource", Resource: "vCPU", Class: "G/OnDemand" }, "Maximum", "GPU"),
    ], { description: "Account-wide on-demand vCPUs (the whole LCPS account, not only Talon)." }),
    stat("Spend this month", g(21, 1, 3, 4), [sql(`
      SELECT coalesce(sum(cost_cents) FILTER (WHERE status IN ('completed', 'failed')
                        AND coalesce(finalized_at, updated_at) >= date_trunc('month', now())), 0) / 100.0 AS "jobs",
             coalesce(sum(reserved_cents) FILTER (WHERE status IN ('queued', 'running')), 0) / 100.0 AS "reserved now"
      FROM reporting.jobs WHERE ${EC2}`)], { unit: "currencyUSD", decimals: 2, description: "EC2 job cost finished this calendar month, and the reservations held by unfinished EC2 jobs (database)." }),

    row("Web and load balancer", 5),
    timeseries("Requests and errors", g(0, 6, 12, 8), [
      cw(ELB, "RequestCount", ALB, "Sum", "requests"),
      cw(ELB, "HTTPCode_Target_4XX_Count", ALB, "Sum", "app 4xx"),
      cw(ELB, "HTTPCode_Target_5XX_Count", ALB, "Sum", "app 5xx"),
      cw(ELB, "HTTPCode_ELB_5XX_Count", ALB, "Sum", "ALB 5xx"),
    ]),
    timeseries("Response time", g(12, 6, 12, 8), [
      cw(ELB, "TargetResponseTime", ALB, "p50", "p50"),
      cw(ELB, "TargetResponseTime", ALB, "p95", "p95"),
      cw(ELB, "TargetResponseTime", ALB, "Maximum", "max"),
    ], { unit: "s" }),
    timeseries("Web server CPU", g(0, 14, 8, 7), [cw("AWS/EC2", "CPUUtilization", WEB, "Average", "${PROP('Dim.InstanceId')}")],
      { unit: "percent", min: 0, links: [linkWeb], description: "Click a line to open that server." }),
    timeseries("Web server memory", g(8, 14, 8, 7), [cw("Talon/Server", "mem_used_percent", WEB, "Average", "${PROP('Dim.InstanceId')}")],
      { unit: "percent", min: 0, links: [linkWeb] }),
    timeseries("Web server disk", g(16, 14, 8, 7), [cw("Talon/Server", "disk_used_percent", WEB, "Maximum", "${PROP('Dim.InstanceId')}")],
      { unit: "percent", min: 0, links: [linkWeb], description: "Root disk; the alarm fires at 85%." }),

    row("Database", 21),
    timeseries("CPU", g(0, 22, 6, 7), [cw("AWS/RDS", "CPUUtilization", RDS, "Average", "CPU")], { unit: "percent", min: 0 }),
    timeseries("Connections", g(6, 22, 6, 7), [cw("AWS/RDS", "DatabaseConnections", RDS, "Maximum", "connections")], { min: 0 }),
    timeseries("Freeable memory", g(12, 22, 6, 7), [cw("AWS/RDS", "FreeableMemory", RDS, "Minimum", "free")], { unit: "bytes" }),
    timeseries("Read and write latency", g(18, 22, 6, 7), [
      cw("AWS/RDS", "ReadLatency", RDS, "Average", "read"), cw("AWS/RDS", "WriteLatency", RDS, "Average", "write"),
    ], { unit: "s" }),

    row("Jobs", 29),
    timeseries("Jobs started, by outcome", g(0, 30, 12, 8), [sql(`
      SELECT $__timeGroupAlias(created_at, '1h'), status AS metric, count(*) AS value
      FROM reporting.jobs WHERE $__timeFilter(created_at)
      GROUP BY 1, 2 ORDER BY 1`, "time_series")], { bars: true, stack: true, min: 0 }),
    barchart("Job cost by machine", g(12, 30, 6, 8), [sql(`
      SELECT compute_type AS machine, sum(cost_cents) / 100.0 AS cost
      FROM reporting.jobs WHERE ${EC2} AND $__timeFilter(created_at)
      GROUP BY 1 ORDER BY 2 DESC`)], { unit: "currencyUSD", description: "EC2 jobs started in the time range." }),
    table("Top spenders", g(18, 30, 6, 8), [sql(`
      SELECT owner_username AS student, count(*) AS jobs, sum(cost_cents) / 100.0 AS cost
      FROM reporting.jobs WHERE ${EC2} AND $__timeFilter(created_at)
      GROUP BY 1 ORDER BY 3 DESC, 2 DESC LIMIT 20`)], { columns: { student: { link: linkStudent }, cost: { unit: "currencyUSD" } }, description: "EC2 jobs started in the time range." }),
    table("Unfinished jobs, then recent ones", g(0, 38, 24, 9), [sql(`
      SELECT id AS job, status, owner_username AS student, coalesce(compute_type, 'local') AS machine,
             instance_id AS instance, created_at AS started, finalized_at AS finished,
             duration_seconds AS duration, reserved_cents / 100.0 AS reserved, cost_cents / 100.0 AS cost, error,
             ${JOB_WINDOW}
      FROM reporting.jobs
      WHERE status IN ('queued', 'running') OR $__timeFilter(created_at)
      ORDER BY (status IN ('queued', 'running')) DESC, created_at DESC
      LIMIT 100`)], { columns: jobColumns, description: "Click a job or a student to drill down." }),

    row("Money", 47),
    timeseries("Job cost per day", g(0, 48, 12, 7), [sql(`
      SELECT $__timeGroupAlias(ended_at, '1d'), sum(cost_cents) / 100.0 AS "job cost"
      FROM (SELECT coalesce(finalized_at, updated_at) AS ended_at, cost_cents
            FROM reporting.jobs WHERE ${EC2} AND status IN ('completed', 'failed')) finished
      WHERE $__timeFilter(ended_at)
      GROUP BY 1 ORDER BY 1`, "time_series")], { unit: "currencyUSD", bars: true, min: 0 }),
    table("Teacher pools", g(12, 48, 6, 7), [sql(`
      SELECT owner_username AS teacher, balance_cents / 100.0 AS balance
      FROM reporting.accounts WHERE kind = 'teacher_pool' ORDER BY balance`)], { columns: { balance: { unit: "currencyUSD" } } }),
    table("Lowest student balances", g(18, 48, 6, 7), [sql(`
      SELECT a.owner_username AS student, a.balance_cents / 100.0 AS balance
      FROM reporting.accounts a WHERE a.kind = 'personal'
        AND EXISTS (SELECT 1 FROM reporting.users u WHERE u.username = a.owner_username AND 'student' = ANY (u.roles))
      ORDER BY a.balance_cents LIMIT 20`)], { columns: { student: { link: linkStudent }, balance: { unit: "currencyUSD" } } }),

    row("Network", 55),
    timeseries("NAT gateway traffic out", g(0, 56, 8, 7), [cw("AWS/NATGateway", "BytesOutToDestination", { NatGatewayId: "$nat" }, "Sum", "${PROP('Dim.NatGatewayId')}")],
      { unit: "bytes", description: "Web servers and job machines reaching GitHub, package indexes and AWS APIs (S3 uses the gateway endpoint)." }),
    timeseries("NAT gateway errors", g(8, 56, 8, 7), [
      cw("AWS/NATGateway", "ErrorPortAllocation", { NatGatewayId: "$nat" }, "Sum", "port allocation ${PROP('Dim.NatGatewayId')}"),
      cw("AWS/NATGateway", "PacketsDropCount", { NatGatewayId: "$nat" }, "Sum", "dropped ${PROP('Dim.NatGatewayId')}"),
    ], { min: 0 }),
    timeseries("Web server network", g(16, 56, 8, 7), [
      cw("AWS/EC2", "NetworkIn", WEB, "Sum", "in ${PROP('Dim.InstanceId')}"),
      cw("AWS/EC2", "NetworkOut", WEB, "Sum", "out ${PROP('Dim.InstanceId')}"),
    ], { unit: "bytes", links: [linkWeb] }),

    row("Logs", 63),
    table("Backend warnings and errors", g(0, 64, 24, 10), [logs([LOG("backend")], `
      fields @timestamp, level, event, msg, error, requestId, jobId, userId, @logStream
      | filter level in ["warn", "error"]
      | sort @timestamp desc
      | limit 200`)], {
      columns: { requestId: { link: linkRequest }, jobId: { link: linkJobKeepTime }, "@logStream": { link: linkWebCell, displayName: "server" } },
      description: "Click a request id to trace it, a job id to open the job, a server to open it.",
    }),
  ],
});

// Status tiles: 4 across in two rows (8 across truncates their titles on a
// laptop screen); everything below moves down one tile row.
{
  let i = 0;
  for (const p of overview.panels) {
    if (p.type === "stat" && p.gridPos.y === 1) {
      p.gridPos = { x: (i % 4) * 6, y: 1 + Math.floor(i / 4) * 4, w: 6, h: 4 };
      i += 1;
    } else if (p.gridPos.y >= 5) {
      p.gridPos.y += 4;
    }
  }
}

// ---- talon-web ----------------------------------------------------------------

const ONE = { InstanceId: "$instance" };
const web = dashboard("talon-web", "Talon web server", {
  description: "One web server: metrics and its logs.",
  variables: [envVar, webVar({ multi: false })],
  panels: [
    timeseries("CPU", g(0, 0, 8, 7), [cw("AWS/EC2", "CPUUtilization", ONE, "Average", "CPU")], { unit: "percent", min: 0 }),
    timeseries("Memory and disk", g(8, 0, 8, 7), [
      cw("Talon/Server", "mem_used_percent", ONE, "Average", "memory"),
      cw("Talon/Server", "disk_used_percent", ONE, "Maximum", "disk"),
    ], { unit: "percent", min: 0 }),
    timeseries("Network", g(16, 0, 8, 7), [
      cw("AWS/EC2", "NetworkIn", ONE, "Sum", "in"), cw("AWS/EC2", "NetworkOut", ONE, "Sum", "out"),
    ], { unit: "bytes" }),
    timeseries("Requests by status (nginx)", g(0, 7, 12, 8), [logs([LOG("nginx-access")], `
      filter @logStream = "$instance"
      | stats count(*) as requests by bin(5m), status`, ["status"])], { bars: true, stack: true }),
    timeseries("Slowest requests (nginx, seconds)", g(12, 7, 12, 8), [logs([LOG("nginx-access")], `
      filter @logStream = "$instance"
      | stats max(requestTime) as slowest, pct(requestTime, 95) as p95 by bin(5m)`)], { unit: "s" }),
    table("Backend warnings and errors", g(0, 15, 24, 9), [logs([LOG("backend")], `
      fields @timestamp, level, event, msg, error, requestId, jobId, userId
      | filter @logStream = "$instance" and level in ["warn", "error"]
      | sort @timestamp desc
      | limit 200`)], { columns: { requestId: { link: linkRequest }, jobId: { link: linkJobKeepTime } } }),
    logsPanel("nginx errors", g(0, 24, 24, 8), [logs([LOG("nginx-error")], `
      fields @timestamp, @message
      | filter @logStream = "$instance"
      | sort @timestamp desc
      | limit 200`)]),
    logsPanel("First boot log", g(0, 32, 24, 8), [logs([LOG("bootstrap")], `
      fields @timestamp, @message
      | filter @logStream = "$instance"
      | sort @timestamp asc
      | limit 500`)], "Set the time range to include the server's launch."),
  ],
});

// ---- talon-job ------------------------------------------------------------------

const JOB = { InstanceId: "$instance" };
const job = dashboard("talon-job", "Talon job", {
  description: "One job: its database row, ledger entries, machine metrics and logs.",
  time: "now-24h", refresh: "",
  variables: [
    envVar,
    pgVar("job_id", "Job", "SELECT id FROM reporting.jobs ORDER BY created_at DESC LIMIT 500"),
    pgVar("instance", "Instance", "SELECT coalesce(instance_id, 'none') FROM reporting.jobs WHERE id = '$job_id'", { hide: 2 }),
  ],
  panels: [
    stat("Job", g(0, 0, 24, 4), [sql(`
      SELECT status, owner_username AS student, coalesce(compute_type, 'local') AS machine,
             coalesce(instance_id, '-') AS instance,
             coalesce(duration_seconds::text || ' s', '-') AS duration,
             '$' || to_char(cost_cents / 100.0, 'FM999990.00') AS cost,
             '$' || to_char(reserved_cents / 100.0, 'FM999990.00') AS reserved
      FROM reporting.jobs WHERE id = '$job_id'`)], { textMode: "value_and_name", colorMode: "none" }),
    table("Details", g(0, 4, 24, 4), [sql(`
      SELECT name, repo, branch, folder, entry_script, provider, created_at AS started, finalized_at AS finished,
             max_runtime_seconds AS "time limit", error
      FROM reporting.jobs WHERE id = '$job_id'`)], { columns: { "time limit": { unit: "s" } } }),
    table("Ledger entries", g(0, 8, 12, 7), [sql(`
      SELECT created_at, kind, amount_cents / 100.0 AS amount, account_owner AS account, note
      FROM reporting.ledger WHERE job_id = '$job_id' ORDER BY created_at`)], { columns: { amount: { unit: "currencyUSD" } } }),
    timeseries("Machine CPU and network", g(12, 8, 12, 7), [
      cw("AWS/EC2", "CPUUtilization", JOB, "Average", "CPU %"),
      cw("AWS/EC2", "NetworkIn", JOB, "Sum", "network in (bytes)"),
      cw("AWS/EC2", "NetworkOut", JOB, "Sum", "network out (bytes)"),
    ], { description: "Basic EC2 metrics, one point every 5 minutes (no agent on job machines: no memory or GPU use yet)." }),
    logsPanel("Job machine log (boot, setup, script output)", g(0, 15, 24, 12), [logs([LOG("jobs")], `
      fields @timestamp, @message
      | filter @logStream like /^$job_id\\//
      | sort @timestamp asc
      | limit 2000`)], "Stream <job id>/<instance id> in the jobs log group, written by job_boot.sh."),
    table("Backend events for this job", g(0, 27, 24, 8), [logs([LOG("backend")], `
      fields @timestamp, level, event, msg, userId, status, instanceId, reason, costCents, error, requestId
      | filter jobId = "$job_id"
      | sort @timestamp asc
      | limit 500`)], { columns: { requestId: { link: linkRequest } } }),
  ],
});

// ---- talon-running ----------------------------------------------------------------

const RUN = { InstanceId: "$running" };
const running = dashboard("talon-running", "Talon running jobs", {
  description: "Jobs running or queued right now. Refreshes every 30 s. Click a job to drill down.",
  time: "now-1h", refresh: "30s",
  variables: [
    envVar,
    pgMultiVar("running", "Running instances", "SELECT instance_id FROM reporting.jobs WHERE status = 'running' AND instance_id IS NOT NULL ORDER BY 1"),
  ],
  panels: [
    stat("Running", g(0, 0, 4, 4), [sql("SELECT count(*) AS running FROM reporting.jobs WHERE status = 'running'")],
      { textMode: "value", description: "From the database (talon_grafana, reporting.jobs)." }),
    stat("Queued", g(4, 0, 4, 4), [sql("SELECT count(*) AS queued FROM reporting.jobs WHERE status = 'queued'")],
      { textMode: "value", thresholds: [{ color: "green", value: null }, { color: "orange", value: 1 }] }),
    stat("On GPU", g(8, 0, 4, 4), [sql("SELECT count(*) AS gpu FROM reporting.jobs WHERE status = 'running' AND compute_type ~ '^g'")],
      { textMode: "value" }),
    stat("Reserved now", g(12, 0, 4, 4), [sql(`
      SELECT coalesce(sum(reserved_cents), 0) / 100.0 AS reserved
      FROM reporting.jobs WHERE status IN ('queued', 'running') AND ${EC2}`)],
      { unit: "currencyUSD", decimals: 2, textMode: "value", description: "Held back from budgets by unfinished EC2 jobs." }),
    stat("Longest running", g(16, 0, 4, 4), [sql(`
      SELECT coalesce(max(extract(epoch FROM now() - created_at)), 0) AS age
      FROM reporting.jobs WHERE status = 'running'`)], { unit: "s", textMode: "value" }),
    stat("Time left, tightest", g(20, 0, 4, 4), [sql(`
      SELECT min(max_runtime_seconds - extract(epoch FROM now() - created_at)) AS left_s
      FROM reporting.jobs WHERE status = 'running' AND max_runtime_seconds IS NOT NULL`)],
      { unit: "s", textMode: "value", description: "The job closest to its time limit." }),

    table("Running and queued jobs", g(0, 4, 24, 8), [sql(`
      SELECT id AS job, status, owner_username AS student, coalesce(compute_type, 'local') AS machine,
             instance_id AS instance, created_at AS started,
             extract(epoch FROM now() - created_at)::int AS age,
             max_runtime_seconds - extract(epoch FROM now() - created_at)::int AS "time left",
             reserved_cents / 100.0 AS reserved,
             ${JOB_WINDOW}
      FROM reporting.jobs
      WHERE status IN ('queued', 'running')
      ORDER BY (status = 'running') DESC, created_at
      LIMIT 100`)], {
      columns: { ...jobColumns, age: { unit: "s" }, "time left": { unit: "s" } },
      description: "Click a job to open its dashboard, or a student. Empty means nothing is running.",
    }),
    timeseries("CPU of running jobs", g(0, 12, 12, 8), [
      cw("AWS/EC2", "CPUUtilization", RUN, "Average", "${PROP('Dim.InstanceId')}"),
    ], { unit: "percent", min: 0, description: "Basic EC2 metrics: one point every 5 minutes. Instance ids match the table above." }),
    timeseries("Network of running jobs", g(12, 12, 12, 8), [
      cw("AWS/EC2", "NetworkIn", RUN, "Sum", "in ${PROP('Dim.InstanceId')}"),
      cw("AWS/EC2", "NetworkOut", RUN, "Sum", "out ${PROP('Dim.InstanceId')}"),
    ], { unit: "bytes" }),
    table("Finished in the last 2 hours", g(0, 20, 24, 8), [sql(`
      SELECT id AS job, status, owner_username AS student, coalesce(compute_type, 'local') AS machine,
             instance_id AS instance, created_at AS started, finalized_at AS finished,
             duration_seconds AS duration, cost_cents / 100.0 AS cost, error,
             ${JOB_WINDOW}
      FROM reporting.jobs
      WHERE status IN ('completed', 'failed') AND finalized_at > now() - interval '2 hours'
      ORDER BY finalized_at DESC
      LIMIT 50`)], { columns: jobColumns }),
    logsPanel("Backend events for jobs (warnings and errors)", g(0, 28, 24, 8), [logs([LOG("backend")], `
      fields @timestamp, level, event, msg, jobId, userId, error
      | filter ispresent(jobId) and level in ["warn", "error"]
      | sort @timestamp desc
      | limit 100`)], "Most recent first."),
  ],
});

// ---- talon-student ----------------------------------------------------------------

const student = dashboard("talon-student", "Talon student", {
  description: "One student: balance, jobs, ledger and classes.",
  time: "now-30d", refresh: "",
  variables: [envVar, pgVar("student", "Student", "SELECT username FROM reporting.users WHERE 'student' = ANY (roles) ORDER BY username")],
  panels: [
    stat("Balance", g(0, 0, 6, 4), [sql(`
      SELECT balance_cents / 100.0 AS balance FROM reporting.accounts WHERE kind = 'personal' AND owner_username = '$student'`)],
      { unit: "currencyUSD", decimals: 2, textMode: "value", thresholds: [{ color: "red", value: null }, { color: "orange", value: 1 }, { color: "green", value: 5 }] }),
    stat("Jobs in range", g(6, 0, 6, 4), [sql(`
      SELECT count(*) FILTER (WHERE status = 'completed') AS completed, count(*) FILTER (WHERE status = 'failed') AS failed,
             count(*) FILTER (WHERE status IN ('queued', 'running')) AS unfinished
      FROM reporting.jobs WHERE owner_username = '$student' AND $__timeFilter(created_at)`)]),
    stat("Cost in range", g(12, 0, 6, 4), [sql(`
      SELECT coalesce(sum(cost_cents), 0) / 100.0 AS cost FROM reporting.jobs WHERE ${EC2} AND owner_username = '$student' AND $__timeFilter(created_at)`)],
      { unit: "currencyUSD", decimals: 2, textMode: "value" }),
    table("Classes", g(18, 0, 6, 4), [sql(`
      SELECT class_name AS class, block, teacher_username AS teacher FROM reporting.class_students
      WHERE student_username = '$student' AND archived_at IS NULL ORDER BY block`)]),
    table("Jobs", g(0, 4, 24, 9), [sql(`
      SELECT id AS job, status, coalesce(compute_type, 'local') AS machine, created_at AS started, finalized_at AS finished,
             duration_seconds AS duration, cost_cents / 100.0 AS cost, error, ${JOB_WINDOW}
      FROM reporting.jobs WHERE owner_username = '$student' AND $__timeFilter(created_at)
      ORDER BY created_at DESC LIMIT 200`)], { columns: jobColumns }),
    table("Ledger", g(0, 13, 24, 9), [sql(`
      SELECT created_at, kind, amount_cents / 100.0 AS amount, job_id AS job, created_by, note
      FROM reporting.ledger WHERE account_owner = '$student' AND account_kind = 'personal' AND $__timeFilter(created_at)
      ORDER BY created_at DESC LIMIT 500`)], { columns: { amount: { unit: "currencyUSD" }, job: { link: linkJobKeepTime } } }),
  ],
});

// ---- talon-request ----------------------------------------------------------------

const request = dashboard("talon-request", "Talon request trace", {
  description: "Every backend and nginx line for one request id (the X-Request-Id nginx and the backend share).",
  time: "now-24h", refresh: "",
  variables: [envVar, textVar("request_id", "Request id")],
  panels: [
    table("nginx", g(0, 0, 24, 6), [logs([LOG("nginx-access")], `
      fields @timestamp, method, path, status, requestTime, @logStream
      | filter requestId = "$request_id"
      | sort @timestamp asc`)], { columns: { requestTime: { unit: "s" }, "@logStream": { link: linkWebCell, displayName: "server" } } }),
    table("Backend", g(0, 6, 24, 12), [logs([LOG("backend")], `
      fields @timestamp, level, event, msg, method, path, status, durationMs, userId, jobId, error
      | filter requestId = "$request_id"
      | sort @timestamp asc`)], { columns: { durationMs: { unit: "ms" }, jobId: { link: linkJobKeepTime } } }),
  ],
});

// ---- write --------------------------------------------------------------------------

mkdirSync(OUT, { recursive: true });
for (const d of [overview, web, running, job, student, request]) {
  writeFileSync(join(OUT, `${d.uid}.json`), JSON.stringify(d, null, 2) + "\n");
  console.log(`wrote dashboards/${d.uid}.json (${d.panels.length} panels)`);
}
