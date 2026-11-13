import { Fragment, useState } from 'react';
import { localTime } from '../agent-diagnostics';
import { Bot, ChevronDown, ChevronRight, Info, LoaderCircle, LockKeyhole, MessagesSquare, Trash2 } from 'lucide-react';
import { collectedRankingRows, formatRankingValue, type ResourceRow, type ResourceSession, type ResourceSnapshot } from './health-data';
type AgentResourceRow = ResourceRow & {
  agentId: string;
  sessions: ResourceSession[];
};
export interface AgentSessionPanelProps {
  row: AgentResourceRow;
  onDisk: boolean;
  blocked: boolean;
  busy: boolean;
  onCleanup: (agentId: string, sessionIds: string[]) => void;
}
export interface ResourceRankingsProps {
  resource: ResourceSnapshot;
  collected?: boolean;
  color: string;
  selectedIds: string[];
  onSelect: (ids: string[]) => void;
  blocked: boolean;
  busy: boolean;
  onCleanupSessions: (agentId: string, sessionIds: string[]) => void;
  agentOnly: boolean;
  onAgentOnlyChange: (agentOnly: boolean) => void;
}
export function formatPercent(value: number) {
  return `${Math.round(value * 10) / 10}%`;
}
export function AgentSessionPanel({
  row,
  onDisk,
  blocked,
  busy,
  onCleanup
}: AgentSessionPanelProps) {
  const [selectedSessionIds, setSelectedSessionIds] = useState<string[]>(() => row.sessions.filter(item => item.cleanable && item.defaultSelected).map(item => item.id));
  const sessions = [...row.sessions].sort((item, current) => current.usage - item.usage);
  const cleanableSessions = sessions.filter(item => item.cleanable);
  const selectedSessions = cleanableSessions.filter(item => selectedSessionIds.includes(item.id));
  const sessionStatusLabels = {
    active: "运行中 · 受保护",
    idle: "空闲",
    completed: "已完成"
  };
  return <div
    className="sh-agent-sessions"
    data-agent-id={row.agentId}
  >
    <div className="sh-agent-session-heading">
      <MessagesSquare size={16} />
      <strong>
        {row.name}
        {" · "}
        {onDisk ? "Session 数据" : "Sessions"}
      </strong>
      <span>
        {sessions.length}
        {" 个会话 · "}
        {formatPercent(row.usage)}
      </span>
    </div>
    <div className="sh-rank-toolbar">
      <label>
        <input
          type="checkbox"
          aria-label={`全选${row.name}可清理Sessions`}
          disabled={blocked || !cleanableSessions.length}
          checked={cleanableSessions.length > 0 && selectedSessions.length === cleanableSessions.length}
          ref={item => {
            item && (item.indeterminate = selectedSessions.length > 0 && selectedSessions.length < cleanableSessions.length);
          }}
          onChange={() => setSelectedSessionIds(selectedSessions.length === cleanableSessions.length ? [] : cleanableSessions.map(item => item.id))}
        />
        {"全选可清理 Session"}
      </label>
      <span>
        {"已选 "}
        {selectedSessions.length}
        {" / "}
        {cleanableSessions.length}
        {" 个可清理会话"}
      </span>
    </div>
    <div className="sh-session-list">
      {sessions.map(item => <label
        className={`sh-session-row ${item.cleanable ? "" : "protected"}`}
        key={item.id}
      >
        <input
          type="checkbox"
          aria-label={`选择Session ${row.name} ${item.id}`}
          disabled={blocked || !item.cleanable}
          checked={selectedSessions.some(current => current.id === item.id)}
          onChange={() => setSelectedSessionIds(current => current.includes(item.id) ? current.filter(id => id !== item.id) : [...current, item.id])}
        />
        <div>
          <strong>
            {item.name}
          </strong>
          <small>
            {item.id}
          </small>
        </div>
        <span className={`sh-session-state ${item.status}`}>
          {sessionStatusLabels[item.status]}
        </span>
        <b>
          {formatPercent(item.usage)}
        </b>
      </label>)}
    </div>
    {!sessions.length && <p className="sh-session-empty">
      {"该 Agent 已没有会话；应用主体仍保留，不会被整进程结束。"}
    </p>}
    <div className="sh-session-footer">
      <span>
        <Info size={12} />
        {onDisk ? "只删除选中 Session 的数据文件，不结束会话进程，CPU、内存等运行资源不变。" : "只清理选中 Session，同步刷新 CPU、能耗、内存等运行资源；不结束整个 Agent。"}
      </span>
      <button
        className="hg-button primary"
        disabled={blocked || !selectedSessions.length}
        onClick={() => onCleanup(row.agentId, selectedSessions.map(item => item.id))}
      >
        {busy ? <LoaderCircle
          size={14}
          className="spinning"
        /> : <Trash2 size={14} />}
        {"清理 "}
        {selectedSessions.length}
        {" 个 Session"}
      </button>
    </div>
  </div>;
}
export function ResourceRankings({
  resource,
  collected = resource.source === 'sysak',
  color,
  selectedIds,
  onSelect,
  blocked,
  busy,
  onCleanupSessions,
  agentOnly,
  onAgentOnlyChange
}: ResourceRankingsProps) {
  const agentRows = resource.rows.filter((row): row is AgentResourceRow => Boolean(row.agentId && row.sessions));
  const [expandedAgentIds, setExpandedAgentIds] = useState<string[]>(() => agentOnly && agentRows.length ? [agentRows[0].agentId] : []);
  const visibleRows = agentOnly ? agentRows : resource.rows.slice(0, 10);
  const cleanableRows = visibleRows.filter(row => row.cleanable);
  const selectedRows = cleanableRows.filter(row => selectedIds.includes(row.id));
  const allSessions = agentRows.flatMap(row => row.sessions);
  function toggleAgent(agentId: string) {
    setExpandedAgentIds(current => current.includes(agentId) ? current.filter(id => id !== agentId) : [...current, agentId]);
  }
  function changeAgentFilter(nextAgentOnly: boolean) {
    nextAgentOnly !== agentOnly && (onAgentOnlyChange(nextAgentOnly), nextAgentOnly && agentRows.length && setExpandedAgentIds([agentRows[0].agentId]));
  }
  if (collected) {
    const rows = collectedRankingRows(resource, agentOnly);
    const eligible = rows.filter(row => row.cleanable);
    const chosen = eligible.filter(row => selectedIds.includes(row.id));
    return <div className="sh-collected-rankings">
      <div className="sh-rank-filter-row">
        <div className="sh-rank-filter" role="group" aria-label="排行筛选">
          <button aria-pressed={!agentOnly} disabled={busy} onClick={() => { onAgentOnlyChange(false); onSelect([]); }}>全部程序</button>
          <button aria-pressed={agentOnly} disabled={busy} onClick={() => { onAgentOnlyChange(true); onSelect([]); }}><Bot size={13} />只看 Agent<span>{resource.rows.filter(row => row.agentKind).length}</span></button>
        </div>
        <span>按常见进程名称白名单识别，可能漏识别；不推断 Session 归属。</span>
      </div>
      <div className="sh-rank-toolbar">
        <label><input type="checkbox" aria-label="全选可结束进程" disabled={blocked || !eligible.length}
          checked={eligible.length > 0 && chosen.length === eligible.length}
          ref={input => { if (input) input.indeterminate = chosen.length > 0 && chosen.length < eligible.length; }}
          onChange={() => onSelect(chosen.length === eligible.length ? [] : eligible.map(row => row.id))} />全选可结束进程</label>
        <span>已选 {chosen.length} 项 · 最多 10 项</span>
      </div>
      <div className="sh-notice"><Info size={14} />
        <span>采集范围：{resource.note || '当前采集样本，排行不代表全部系统占用。'}
          {resource.sampledAt && ` · 采样 ${localTime(resource.sampledAt)}`}
        </span>
      </div>
      {rows.length ? <div className="sh-rank-table"><table>
        <thead><tr><th>选择</th><th>排行 / PID</th><th>进程 / 对象名称</th><th>{resource.rankLabel || '资源指标'}（{resource.rankUnit || '%'}）</th><th>操作范围</th></tr></thead>
        <tbody>{rows.map((row, index) => <tr key={row.id} data-row-id={row.id}>
          <td><input type="checkbox" aria-label={`选择进程 ${row.name} PID ${row.pid ?? '无'}`} disabled={blocked || !row.cleanable}
            checked={chosen.some(item => item.id === row.id)}
            onChange={() => onSelect(selectedIds.includes(row.id) ? selectedIds.filter(id => id !== row.id) : [...selectedIds, row.id])} /></td>
          <td>{index + 1} / {row.pid ?? '—'}</td>
          <td><div className="sh-ranked-name"><div><strong>{row.name}{row.agentKind && <em> · {row.agentKind} Agent</em>}</strong><small>{row.detail}</small></div></div></td>
          <td><b>{formatRankingValue(resource, row)}</b></td>
          <td><span className={row.cleanable ? 'sh-cleanable' : 'sh-protected'}>{row.cleanable ? '可结束' : '受保护 / 不可用'}</span><small>{row.effect}</small></td>
        </tr>)}</tbody>
      </table></div> : <p className="sh-empty">{agentOnly ? '本次采样未识别到白名单 Agent；不代表没有 Agent 运行。' : '本次采集范围内没有可用排行数据；不代表系统没有资源占用。'}</p>}
      <p className="sh-muted">仅允许结束当前用户的非受保护进程；不清理文件，不提供 Session 级操作。</p>
    </div>;
  }
  return <>
    {agentRows.length > 0 && <div className="sh-rank-filter-row">
      <div
        className="sh-rank-filter"
        role="group"
        aria-label="排行筛选"
      >
        <button
          aria-pressed={!agentOnly}
          disabled={busy}
          onClick={() => changeAgentFilter(false)}
        >
          {"全部程序"}
          <span>
            {Math.min(10, resource.rows.length)}
          </span>
        </button>
        <button
          aria-pressed={agentOnly}
          disabled={busy}
          onClick={() => changeAgentFilter(true)}
        >
          <Bot size={13} />
          {"只看 Agent"}
          <span>
            {agentRows.length}
          </span>
        </button>
      </div>
      <span>
        {agentOnly ? `已过滤出 Agent 相关${resource.id === "disk" ? "数据" : "进程"}，展开后可按 Session 选择清理` : "Agent 应用可展开 Session；切换“只看 Agent”集中处理"}
      </span>
    </div>}
    {agentOnly ? <div className="sh-rank-toolbar agent-view">
      <span className="sh-agent-view-note">
        <LockKeyhole size={12} />
        {resource.id === "disk" ? "运行中 Session 的数据受保护，不提供整目录删除" : "Agent 主体与运行中 Session 受保护，不提供整进程清理"}
      </span>
      <span>
        {agentRows.length}
        {" 个 Agent · "}
        {allSessions.length}
        {" 个 Session ·"}
        {" "}
        {allSessions.filter(row => row.cleanable).length}
        {" "}
        {"个可清理"}
      </span>
    </div> : <div className="sh-rank-toolbar">
      <label>
        <input
          type="checkbox"
          aria-label="全选可清理排行项"
          checked={cleanableRows.length > 0 && selectedRows.length === cleanableRows.length}
          ref={row => {
            row && (row.indeterminate = selectedRows.length > 0 && selectedRows.length < cleanableRows.length);
          }}
          disabled={blocked || !cleanableRows.length}
          onChange={() => onSelect(selectedRows.length === cleanableRows.length ? [] : cleanableRows.map(row => row.id))}
        />
        {"全选程序级清理项"}
      </label>
      <span>
        {"已选 "}
        {selectedRows.length}
        {" 项 · "}
        {visibleRows.length}
        {" 个程序 / 对象"}
      </span>
    </div>}
    <div className="sh-rank-table">
      <table>
        <thead>
          <tr>
            <th>
              {agentOnly ? "类型" : "选择"}
            </th>
            <th>
              {"排行 / 占用对象"}
            </th>
            <th>
              {resource.id === "energy" ? "预算占比" : "占用率"}
            </th>
            <th>
              {"操作范围"}
            </th>
          </tr>
        </thead>
        <tbody>
          {visibleRows.map(row => {
            const isAgent = !!(row.agentId! && row.sessions);
            const expanded = isAgent && expandedAgentIds.includes(row.agentId!);
            return <Fragment key={row.id}>
              <tr
                data-row-id={row.id}
                className={isAgent ? "agent-application" : ""}
              >
                <td>
                  {agentOnly ? <span className="sh-agent-type">
                    <Bot size={14} />
                  </span> : <input
                    type="checkbox"
                    aria-label={`选择${row.name}`}
                    disabled={blocked || !row.cleanable}
                    checked={selectedRows.some(entry => entry.id === row.id)}
                    onChange={() => onSelect(selectedIds.includes(row.id) ? selectedIds.filter(entry => entry !== row.id) : [...selectedIds, row.id])}
                  />}
                </td>
                <td>
                  <div className="sh-ranked-name">
                    <span>
                      {resource.rows.indexOf(row) + 1}
                    </span>
                    <div>
                      {isAgent ? <button
                        className="sh-agent-expand"
                        aria-label={`${expanded ? "收起" : "展开"}${row.name}的Sessions`}
                        aria-expanded={expanded}
                        onClick={() => toggleAgent(row.agentId!)}
                      >
                        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                        <strong>
                          {row.name}
                        </strong>
                        <em>
                          {"Agent"}
                        </em>
                      </button> : <strong>
                        {row.name}
                      </strong>}
                      <small>
                        {agentOnly ? `${row.sessions!.length} Sessions · ${row.sessions!.filter(entry => entry.status === "active").length} 运行中 · ${row.sessions!.filter(entry => entry.cleanable).length} 可清理` : `${row.detail}${row.sessions ? ` · ${row.sessions!.length} Sessions` : ""}`}
                      </small>
                    </div>
                  </div>
                </td>
                <td>
                  <div className="sh-ranked-usage">
                    <span>
                      <i style={{
                        width: `${Math.min(100, row.usage * 2)}%`,
                        background: color
                      }} />
                    </span>
                    <b>
                      {formatPercent(row.usage)}
                    </b>
                  </div>
                </td>
                <td>
                  {isAgent ? <button
                    className="sh-session-entry"
                    disabled={busy}
                    onClick={() => toggleAgent(row.agentId!)}
                  >
                    {"Session 管理"}
                    <ChevronRight size={12} />
                  </button> : row.cleanable ? <span className="sh-cleanable">
                    {"Demo 可回收"}
                  </span> : <span className="sh-protected">
                    <LockKeyhole size={11} />
                    {"受保护"}
                  </span>}
                </td>
              </tr>
              {expanded && <tr className="sh-session-container">
                <td colSpan={4}>
                  <AgentSessionPanel
                    row={row as AgentResourceRow}
                    onDisk={resource.id === "disk"}
                    blocked={blocked}
                    busy={busy}
                    onCleanup={onCleanupSessions}
                  />
                </td>
              </tr>}
            </Fragment>;
          })}
        </tbody>
      </table>
    </div>
    {!visibleRows.length && <p className="sh-empty">
      {agentOnly ? "当前资源没有 Agent 相关进程。" : "没有占用对象，暂无清理项。"}
    </p>}
  </>;
}
