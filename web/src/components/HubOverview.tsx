// The overview of one hub, shown in the details drawer: the figures and lists the side cards used
// to hold, now reached from the graph. Each part reads the snapshot and the optional data sets the
// controller already holds; nothing here fetches. A click that opens a node goes through the
// controller, so the brain flies to it and selects it.
import { useState } from 'react';
import type { ExtraStatus, OsController, OsSelection, ViewState } from '../controller';
import type { CoreView } from '../systemGraph';
import type { OsActivityItem, OsCancel, OsRoutine, OsSkill, OsSnapshot, OsUsageCounts } from '../types';
import { clusterSummary, uniqueCoreNodes } from '../orbit/scene';
import { fmtInt, fmtTime, pct, shortSha, words } from '../format';
import { Bar, Empty } from './common';
import { Recent } from './Recent';

type Snapshot = OsSnapshot;
type Tokens = Snapshot['tokens'];
type Running = Snapshot['running'];

export type HubOverviewProps = {
  hub: string;
  data: Snapshot;
  state: ViewState;
  controller: OsController;
  /** The project's drawn core (the code overview counts and ranks it). */
  core: CoreView;
  selected: OsSelection | null;
};

/* ---- Models: token flow ---- */

type Row = { key: string; label: string; detail: string; billable: number; calls: number };

/** Top five rows by billable tokens, bars scaled to the largest. */
function Breakdown({ rows, label }: { rows: Row[]; label: string }) {
  const top = [...rows].sort((a, b) => b.billable - a.billable).slice(0, 5);
  const max = top.reduce((m, r) => Math.max(m, r.billable), 0);
  if (top.length === 0) return <p className="meta">No {label} in this window.</p>;
  return (
    <ul className="breakdown">
      {top.map((row) => (
        <li key={row.key}>
          <div className="breakdown-head">
            <span>
              {row.label}
              {row.detail ? <span className="meta"> · {row.detail}</span> : null}
            </span>
            <span className="meta">
              {fmtInt(row.billable)} billable · {fmtInt(row.calls)} calls
            </span>
          </div>
          <Bar value={row.billable} max={max} label={`${row.label}: ${fmtInt(row.billable)} billable tokens`} />
        </li>
      ))}
    </ul>
  );
}

function Totals({ totals }: { totals: OsUsageCounts }) {
  const items: Array<[string, number]> = [
    ['Calls', totals.calls],
    ['Input', totals.input],
    ['Output', totals.output],
    ['Cache read', totals.cacheRead],
    ['Cache write', totals.cacheWrite],
    ['Billable', totals.billable],
  ];
  return (
    <dl className="totals">
      {items.map(([name, value]) => (
        <div key={name}>
          <dt>{name}</dt>
          <dd>{fmtInt(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ModelsOverview({ tokens }: { tokens: Tokens }) {
  const { totals, turnComposition: turns } = tokens;
  const promptTokens = totals.input + totals.cacheRead + totals.cacheWrite;
  const windowLabel = tokens.window === 'day' ? 'today (since midnight)' : 'the last 7 days (incl. today)';

  // Per-turn split, from the first call's real prompt size. The static prefix and the
  // injected context are chars/4 estimates, so the remainder is an estimate too.
  const prefix = turns.avgPrefixTokens ?? 0;
  const fence = turns.avgFenceTokens ?? 0;
  const toolResults = turns.avgToolResultTokens ?? 0;
  const firstCall = turns.avgFirstCallPromptTokens;
  const other = firstCall === null ? 0 : Math.max(0, firstCall - prefix - fence - toolResults);
  const compositionRows = [
    { label: 'Static prefix', value: prefix },
    { label: 'Injected context', value: fence },
    { label: 'Tool results', value: toolResults },
    { label: 'Transcript and other', value: other },
  ];
  const compositionMax = Math.max(1, ...compositionRows.map((r) => r.value));

  return (
    <div className="hub-body">
      <h3 className="sub-title">Token flow</h3>
      <p className="meta">Window: {windowLabel}.</p>
      {totals.calls === 0 ? (
        <Empty>No model calls in this window yet.</Empty>
      ) : (
        <>
          <Totals totals={totals} />
          <h3 className="sub-title">Cache</h3>
          <p className="meta">
            Cache read is {pct(totals.cacheRead, promptTokens)}% of prompt tokens; cache write is{' '}
            {pct(totals.cacheWrite, promptTokens)}%.
          </p>
          <Bar value={totals.cacheRead} max={promptTokens} label="Cache read share of prompt tokens" />
          <h3 className="sub-title">By model</h3>
          <Breakdown
            label="models"
            rows={tokens.byModel.map((m) => ({
              key: `${m.provider}/${m.model}`,
              label: m.model,
              detail: m.provider,
              billable: m.billable,
              calls: m.calls,
            }))}
          />
          <h3 className="sub-title">By source</h3>
          <Breakdown
            label="sources"
            rows={tokens.bySource.map((s) => ({
              key: s.source,
              label: words(s.source),
              detail: '',
              billable: s.billable,
              calls: s.calls,
            }))}
          />
          <h3 className="sub-title">By endpoint</h3>
          <Breakdown
            label="endpoints"
            rows={tokens.byEndpoint.map((e) => ({
              key: e.endpoint ?? 'unknown',
              label: e.endpoint ?? 'unknown',
              detail: '',
              billable: e.billable,
              calls: e.calls,
            }))}
          />
        </>
      )}
      <h3 className="sub-title">
        Per chat turn, average of {fmtInt(turns.turns)} {turns.turns === 1 ? 'turn' : 'turns'}
      </h3>
      {turns.turns === 0 ? (
        <Empty>No chat turns recorded yet.</Empty>
      ) : (
        <>
          <ul className="composition">
            {compositionRows.map((row) => (
              <li key={row.label}>
                <div className="breakdown-head">
                  <span>{row.label}</span>
                  <span className="meta">{fmtInt(row.value)} tokens</span>
                </div>
                <Bar value={row.value} max={compositionMax} label={`${row.label}: ${fmtInt(row.value)} tokens`} />
              </li>
            ))}
          </ul>
          <p className="meta">
            First-call prompt: {firstCall === null ? 'not recorded' : `${fmtInt(firstCall)} tokens`}. The split above
            is estimated (chars / 4); the remainder is what the first call sent beyond the prefix and context.
          </p>
        </>
      )}
    </div>
  );
}

/* ---- Kits: system map ---- */

const CHECKS: Array<{ key: 'db' | 'claude' | 'skills'; label: string }> = [
  { key: 'db', label: 'Database' },
  { key: 'claude', label: 'Claude CLI' },
  { key: 'skills', label: 'Skills' },
];

export function KitsOverview({ system, controller }: { system: Snapshot['system']; controller: OsController }) {
  const features = system.features ? system.features.join(', ') : 'all features on';
  return (
    <div className="hub-body">
      <h3 className="sub-title">System map</h3>
      <p className="meta">
        Server {system.status === 'ok' ? 'healthy' : 'degraded'} · {features}
      </p>
      <ul className="checks" aria-label="Health checks">
        {CHECKS.map(({ key, label }) => {
          const ok = system.checks[key];
          const error = key === 'claude' ? system.checks.claudeError : key === 'skills' ? system.checks.skillsError : undefined;
          return (
            <li key={key}>
              <span className={ok ? 'dot dot-ok' : 'dot dot-bad'} aria-hidden="true" />
              <span>{label}</span>
              <span className="meta">{ok ? 'ok' : 'failed'}</span>
              {error ? <span className="meta"> · {error}</span> : null}
            </li>
          );
        })}
      </ul>
      <ul className="kits">
        {system.kits.map((kit) => (
          <li key={kit.id} className={kit.enabled ? 'kit kit-on' : 'kit kit-off'}>
            <button
              type="button"
              className="os-open-btn"
              aria-label={`Show ${kit.id} in the brain`}
              onClick={() => controller.openNode('kits', { id: `kit:${kit.id}`, label: kit.id, detail: 'kit' })}
            >
              <span className="kit-name">{kit.id}</span>
              <span className="meta block">
                {kit.enabled ? 'On' : 'Off'} · {kit.requires.length ? `needs ${kit.requires.join(', ')}` : 'always on'}
              </span>
            </button>
            {!kit.enabled ? (
              <button type="button" className="btn" onClick={() => controller.open('settings')}>
                Turn on in Settings
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ---- Knowledge: memory and knowledge ---- */

/** The last path segment of a repo root, as the brain labels the repo. */
function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export function KnowledgeOverview({ knowledge, controller }: { knowledge: Snapshot['knowledge']; controller: OsController }) {
  const empty =
    knowledge.sources.total === 0 && knowledge.meetings.count === 0 && knowledge.outcomes.total === 0 && knowledge.codeGraph.length === 0;
  return (
    <div className="hub-body">
      <h3 className="sub-title">Memory and knowledge</h3>
      {empty ? <Empty>Nothing indexed yet. Add a source or a meeting in Library and it shows up here.</Empty> : null}
      <dl className="totals">
        <div>
          <dt>Sources</dt>
          <dd>{fmtInt(knowledge.sources.total)}</dd>
        </div>
        <div>
          <dt>Meetings</dt>
          <dd>{fmtInt(knowledge.meetings.count)}</dd>
        </div>
        <div>
          <dt>Pending reviews</dt>
          <dd>{fmtInt(knowledge.pendingReviews)}</dd>
        </div>
        <div>
          <dt>Outcomes</dt>
          <dd>
            {fmtInt(knowledge.outcomes.total)}
            <span className="meta"> · {fmtInt(knowledge.outcomes.terminal)} finished</span>
          </dd>
        </div>
      </dl>
      <button type="button" className="btn btn-primary" onClick={() => controller.open('library')}>
        Open Library
      </button>

      {knowledge.sources.byKind.length > 0 ? (
        <>
          <h3 className="sub-title">Sources by kind</h3>
          <ul className="plain">
            {knowledge.sources.byKind.map((row) => (
              <li key={row.kind}>
                <button
                  type="button"
                  className="os-open-btn"
                  onClick={() => controller.openNode('knowledge', { id: `source:${row.kind}`, label: words(row.kind), detail: 'sourceKind' })}
                >
                  {words(row.kind)}: {fmtInt(row.count)} <span className="meta">· indexed {fmtTime(row.lastIndexedAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {knowledge.codeGraph.length > 0 ? (
        <>
          <h3 className="sub-title">Code graph</h3>
          <ul className="plain">
            {knowledge.codeGraph.map((repo) => (
              <li key={repo.repoId}>
                <button
                  type="button"
                  className="os-open-btn"
                  onClick={() => controller.openNode('knowledge', { id: `codegraph:${repo.repoId}`, label: repo.repoId, detail: 'codeCluster' })}
                >
                  {repo.repoId} <span className="meta">· {shortSha(repo.commitSha)} · built {fmtTime(repo.generatedAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

/* ---- Memory: project memory repos ---- */

export function MemoryOverview({ knowledge, controller }: { knowledge: Snapshot['knowledge']; controller: OsController }) {
  return (
    <div className="hub-body">
      <h3 className="sub-title">Project memory</h3>
      {knowledge.projectMemory.length === 0 ? (
        <Empty>No project memory yet. Facts the agent confirms for a repo show up here.</Empty>
      ) : (
        <table className="os-table">
          <thead>
            <tr>
              <th scope="col">Repo</th>
              <th scope="col">Facts</th>
              <th scope="col">Active</th>
              <th scope="col">Superseded</th>
              <th scope="col">Last confirmed</th>
            </tr>
          </thead>
          <tbody>
            {knowledge.projectMemory.map((repo) => (
              <tr key={repo.repoRoot}>
                <td>
                  <button
                    type="button"
                    className="os-open-btn os-table-title"
                    onClick={() => controller.openNode('memory', { id: `memory:${repo.repoRoot}`, label: baseName(repo.repoRoot), detail: 'memoryRepo' })}
                  >
                    {baseName(repo.repoRoot)}
                  </button>
                  <span className="meta block" title={repo.repoRoot}>
                    {repo.repoRoot}
                  </span>
                </td>
                <td>{fmtInt(repo.facts)}</td>
                <td>{fmtInt(repo.active)}</td>
                <td>{fmtInt(repo.superseded)}</td>
                <td>{fmtTime(repo.lastConfirmedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/* ---- Skills ---- */

function SkillRow({ skill, controller }: { skill: OsSkill; controller: OsController }) {
  return (
    <li className="skill-card">
      <button
        type="button"
        className="os-open-btn"
        aria-label={`Show ${skill.name} in the brain`}
        onClick={() => controller.openNode('skills', { id: `skill:${skill.id}`, label: skill.name, detail: 'skill' })}
      >
        <span className="skill-head">
          <strong className="skill-name">{skill.name}</strong>
          {skill.source ? <span className="chip">{skill.source}</span> : null}
        </span>
        {skill.description ? <span className="skill-desc">{skill.description}</span> : null}
      </button>
    </li>
  );
}

/** Whether a skill matches a search: its name, source or description, case-insensitively. */
export function skillMatches(skill: OsSkill, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  return [skill.name, skill.source ?? '', skill.description ?? ''].some((text) => text.toLowerCase().includes(q));
}

export function SkillsOverview({ skills, status, controller }: { skills: OsSkill[] | null; status: ExtraStatus; controller: OsController }) {
  const [query, setQuery] = useState('');
  const shown = skills ? skills.filter((skill) => skillMatches(skill, query)) : [];
  return (
    <div className="hub-body">
      <h3 className="sub-title">
        Skills{' '}
        {skills !== null ? <span className="meta">{fmtInt(skills.length)}</span> : null}
      </h3>
      {skills !== null && skills.length > 0 ? (
        <>
          <input
            type="search"
            className="os-filter-input"
            aria-label="Search skills"
            placeholder="Search skills…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {shown.length > 0 ? (
            <ul className="skill-deck">
              {shown.map((skill) => (
                <SkillRow key={skill.id} skill={skill} controller={controller} />
              ))}
            </ul>
          ) : (
            <p className="meta" role="status">
              No skill matches “{query.trim()}”.
            </p>
          )}
        </>
      ) : status === 'error' ? (
        <Empty>Could not load skills.</Empty>
      ) : status === 'none' ? (
        <Empty>Skills are not available in this host.</Empty>
      ) : status === 'ready' ? (
        <Empty>No skills yet. Skills you add to the project show up here.</Empty>
      ) : (
        <p className="meta" aria-live="polite">
          Loading skills…
        </p>
      )}
    </div>
  );
}

/* ---- Routines ---- */

export function RoutinesOverview({ routines, status, controller }: { routines: OsRoutine[] | null; status: ExtraStatus; controller: OsController }) {
  return (
    <div className="hub-body">
      <h3 className="sub-title">Routines</h3>
      <div className="hub-actions">
        <button type="button" className="btn" onClick={() => controller.open('loop')}>
          Open Loop
        </button>
        <button type="button" className="btn" onClick={() => controller.open('autoTasks')}>
          Open Auto Tasks
        </button>
      </div>
      <p className="meta">Loop and Auto Tasks run on this Mac. Their routines are listed here when the host reports them.</p>
      {routines !== null && routines.length > 0 ? (
        <table className="os-table">
          <thead>
            <tr>
              <th scope="col">
                <span className="sr-only">Enabled</span>
              </th>
              <th scope="col">Routine</th>
              <th scope="col">Schedule</th>
              <th scope="col">Next run</th>
              <th scope="col">Last run</th>
            </tr>
          </thead>
          <tbody>
            {routines.map((routine) => (
              <tr key={routine.id}>
                <td>
                  <span className={routine.enabled ? 'dot dot-ok' : 'dot'} aria-label={routine.enabled ? 'Enabled' : 'Paused'} role="img" />
                </td>
                <td>
                  <button
                    type="button"
                    className="os-open-btn os-table-title"
                    aria-label={`Show ${routine.title} in the brain`}
                    onClick={() => controller.openNode('routines', { id: `routine:${routine.id}`, label: routine.title, detail: 'routine' })}
                  >
                    {routine.title}
                  </button>
                  <span className="meta block">{routine.enabled ? 'Enabled' : 'Paused'}</span>
                </td>
                <td>{routine.schedule ? routine.schedule : 'No schedule'}</td>
                <td>{routine.nextRunAt ? fmtTime(routine.nextRunAt) : '—'}</td>
                <td>{routine.lastRunAt ? fmtTime(routine.lastRunAt) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : status === 'error' ? (
        <Empty>Could not load routines.</Empty>
      ) : status === 'none' ? (
        <Empty>Routines are not available in this host.</Empty>
      ) : status === 'ready' ? (
        <Empty>No routines yet.</Empty>
      ) : (
        <p className="meta">Loading routines…</p>
      )}
    </div>
  );
}

/* ---- Agents: running now ---- */

function RunRow({
  title,
  detail,
  cancel,
  stopKey,
  stopping,
  onStop,
}: {
  title: string;
  detail: string;
  cancel: OsCancel;
  stopKey: string;
  stopping: string | null;
  onStop: (cancel: OsCancel, key: string) => void;
}) {
  const busy = stopping === stopKey;
  return (
    <li className="row">
      <div className="row-main">
        <strong>{title}</strong>
        <div className="meta">{detail}</div>
      </div>
      {cancel ? (
        <button
          type="button"
          className="btn btn-danger"
          aria-label={`Stop ${title.toLowerCase()}`}
          disabled={stopping !== null}
          onClick={() => onStop(cancel, stopKey)}
        >
          {busy ? 'Stopping…' : 'Stop'}
        </button>
      ) : (
        <span className="meta">Stop it in the Mac app</span>
      )}
    </li>
  );
}

export function AgentsOverview({
  running,
  stopping,
  onStop,
}: {
  running: Running;
  stopping: string | null;
  onStop: (cancel: OsCancel, key: string) => void;
}) {
  const total = running.chatTurns.length + running.meetingAgentRuns.length + running.liveSessions.length;
  return (
    <div className="hub-body">
      <h3 className="sub-title">Running now</h3>
      {total === 0 ? (
        <Empty>Nothing is running. Chat turns, meeting agents and live captures appear here while they work.</Empty>
      ) : (
        <ul className="rows">
          {running.chatTurns.map((turn) => (
            <RunRow
              key={`chat-${turn.chatSessionId}`}
              title="Chat turn"
              detail={`Started ${fmtTime(turn.startedAt)} · session ${turn.chatSessionId}`}
              cancel={turn.cancel}
              stopKey={`chat-${turn.chatSessionId}`}
              stopping={stopping}
              onStop={onStop}
            />
          ))}
          {running.meetingAgentRuns.map((run) => (
            <RunRow
              key={`agent-${run.sessionId}`}
              title="Meeting agent"
              detail={`Started ${fmtTime(run.startedAt)}${run.planId ? ` · plan ${run.planId}` : ''}`}
              cancel={run.cancel}
              stopKey={`agent-${run.sessionId}`}
              stopping={stopping}
              onStop={onStop}
            />
          ))}
          {running.liveSessions.map((session) => (
            <RunRow
              key={`live-${session.sessionId}`}
              title="Live capture"
              detail={`${session.meetingTitle ?? 'Untitled meeting'} · ${fmtInt(session.captionCount)} captions · last ${fmtTime(session.lastWrite)}`}
              cancel={session.cancel}
              stopKey={`live-${session.sessionId}`}
              stopping={stopping}
              onStop={onStop}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/* ---- Activity: the timeline ---- */

/** The timeline of recent activity. A row selects its ring item (the brain flies to it where it is drawn). */
export function ActivityOverview({
  items,
  controller,
  selected,
  heading = 'Recent',
  limit,
}: {
  items: OsActivityItem[];
  controller: OsController;
  selected: OsSelection | null;
  heading?: string;
  limit?: number;
}) {
  return (
    <div className="hub-body">
      <h3 className="sub-title">{heading}</h3>
      <Recent items={items} controller={controller} selected={selected} limit={limit} />
    </div>
  );
}

/* ---- Code: the project's graph ---- */

export function CodeOverview({ core, repos }: { core: CoreView; repos: number }) {
  const nodes = uniqueCoreNodes(core.graph);
  const clusters = clusterSummary(nodes);
  const top = [...clusters].sort((a, b) => b.count - a.count).slice(0, 5);
  const topMax = top.reduce((m, c) => Math.max(m, c.count), 0);
  const truncated = core.graph.truncated.totalNodes > core.graph.truncated.keptNodes;
  return (
    <div className="hub-body">
      <h3 className="sub-title">Code</h3>
      <dl className="totals">
        <div>
          <dt>Nodes</dt>
          <dd>{fmtInt(nodes.length)}</dd>
        </div>
        <div>
          <dt>Communities</dt>
          <dd>{fmtInt(clusters.length)}</dd>
        </div>
        <div>
          <dt>Repos</dt>
          <dd>{fmtInt(repos)}</dd>
        </div>
      </dl>
      {truncated ? (
        <p className="meta">
          Showing {fmtInt(core.graph.truncated.keptNodes)} of {fmtInt(core.graph.truncated.totalNodes)} nodes.
        </p>
      ) : null}
      {top.length > 0 ? (
        <>
          <h3 className="sub-title">Largest clusters</h3>
          <ul className="breakdown">
            {top.map((c) => (
              <li key={c.community}>
                <div className="breakdown-head">
                  <span>Cluster {fmtInt(c.community + 1)}</span>
                  <span className="meta">{fmtInt(c.count)} nodes</span>
                </div>
                <Bar value={c.count} max={topMax} label={`Cluster ${c.community + 1}: ${fmtInt(c.count)} nodes`} />
              </li>
            ))}
          </ul>
        </>
      ) : (
        <Empty>No code graph yet. Build one for a repo and its clusters show up here.</Empty>
      )}
      <p className="meta">
        Select a node in the brain, or search for one above, to see what it depends on, what uses it and its file.
      </p>
    </div>
  );
}

/* ---- The dispatcher ---- */

/** The overview a hub shows in the details drawer. An unknown hub (not drawn in this build) shows nothing. */
export function HubOverview({ hub, data, state, controller, core, selected }: HubOverviewProps) {
  const stop = (cancel: OsCancel, key: string) => void controller.stopItem(cancel, key);
  switch (hub) {
    case 'models':
      return <ModelsOverview tokens={data.tokens} />;
    case 'kits':
      return <KitsOverview system={data.system} controller={controller} />;
    case 'knowledge':
      return <KnowledgeOverview knowledge={data.knowledge} controller={controller} />;
    case 'memory':
      return <MemoryOverview knowledge={data.knowledge} controller={controller} />;
    case 'skills':
      return <SkillsOverview skills={state.skills} status={state.skillsStatus} controller={controller} />;
    case 'routines':
      return <RoutinesOverview routines={state.routines} status={state.routinesStatus} controller={controller} />;
    case 'agents':
      return <AgentsOverview running={data.running} stopping={state.stopping} onStop={stop} />;
    case 'activity':
      return <ActivityOverview items={data.activity.items} controller={controller} selected={selected} heading="Activity" />;
    case 'code':
      return <CodeOverview core={core} repos={data.knowledge.codeGraph.length} />;
    default:
      return <Empty>Nothing to show for this part.</Empty>;
  }
}
