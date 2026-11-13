import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import { ArrowUpRight, BellRing, Check, LoaderCircle, MousePointer2, Play, Square, X } from 'lucide-react';
import App from './App';
import { MascotFigure } from './components';
import { availableAlertTargets, createInitialState, type AlertTarget, type HealthState } from './health-data';
import { fetchHealthSnapshot, setAlertSample } from './health-api';
import { detectGpu } from './gpu-presence';

const demoTargets: { id: AlertTarget; label: string }[] = [
  { id: 'cpu', label: 'CPU 利用率' },
  { id: 'energy', label: '能耗预算占比' },
  { id: 'memory', label: '系统内存' },
  { id: 'gpu', label: 'GPU 利用率' },
  { id: 'root', label: '根目录使用率' },
  { id: 'fd', label: 'FD 使用率' },
];

function stateTargets(state: HealthState) {
  const available = availableAlertTargets(state);
  return demoTargets.filter((target) => available.includes(target.id));
}

function targetUsage(state: HealthState, target: AlertTarget): number | null {
  if (target === 'fd') {
    const inspection = state.inspections.find((item) => item.id === 'fd');
    return inspection?.status === 'unchecked' ? null : inspection?.usage ?? null;
  }
  const resource = state.resources[target === 'root' ? 'disk' : target];
  return resource.status === 'unavailable' ? null : resource.usage;
}

interface Position {
  x: number;
  y: number;
}

interface DragState extends Position {
  id: number;
  origin: Position;
  moved: boolean;
}

interface ResourceAlert {
  revision: number;
  items: { target: AlertTarget; label: string; usage: number }[];
}

type DemoStage = 'idle' | 'preparing' | 'waiting' | 'raising' | 'done';

const mascotSize = 96;
const mascotMargin = 14;

function clampPosition(position: Position): Position {
  return {
    x: Math.max(mascotMargin, Math.min(window.innerWidth - mascotSize - mascotMargin, position.x)),
    y: Math.max(mascotMargin, Math.min(window.innerHeight - mascotSize - mascotMargin, position.y)),
  };
}

function Mascot() {
  return (
    <svg className="sysom-mascot" viewBox="0 0 180 190" aria-hidden="true">
      <MascotFigure />
    </svg>
  );
}

export function FloatingMascot() {
  const [state, setState] = useState<DesktopLauncherState>({ revision: 0, pulseRevision: null, items: [] });
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);

  useEffect(() => {
    const desktop = window.sysomDesktop!;
    let alive = true;
    const unsubscribe = desktop.onLauncherState(setState);
    desktop.getLauncherState().then((value) => { if (alive) setState(value); });
    return () => { alive = false; unsubscribe(); };
  }, []);

  function finishDrag(event: PointerEvent<HTMLButtonElement>) {
    if (!drag.current || drag.current.id !== event.pointerId) return;
    suppressClick.current = drag.current.moved || event.type === 'pointercancel';
    drag.current = null;
    setDragging(false);
    window.sysomDesktop!.endDrag();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  return (
    <div className="native-mascot" onContextMenu={(event) => {
      event.preventDefault();
      window.sysomDesktop!.showLauncherMenu();
    }}>
      {state.items.length > 0 && (
        <div className="mascot-alert-card" role="alert">
          <div className="mascot-alert-heading">
            <BellRing size={15} /><strong>资源阈值告警{state.mode === 'demo' ? ' · Demo' : ''}</strong>
            <button aria-label="关闭资源告警" onClick={() => window.sysomDesktop!.dismissAlert()}><X size={13} /></button>
          </div>
          {state.items.map((item) => (
            <p key={item.label}><span>{item.label}</span><b className={item.usage > 90 ? 'hot' : 'recovered'}>{item.usage}%{item.usage <= 90 && ' · 已回落'}</b></p>
          ))}
          <small>阈值 &gt;90% · 快照 v{state.revision} · 不自动清理任务。</small>
          <button className="mascot-alert-open" onClick={() => window.sysomDesktop!.openHome()}>查看本机健康<ArrowUpRight size={12} /></button>
        </div>
      )}
      <div className={`mascot-launcher ${dragging ? 'dragging' : ''} ${state.pulseRevision !== null ? 'alert-pulse' : ''} ${state.items.length ? 'has-alert' : ''}`} data-alert-revision={state.items.length ? state.revision : undefined}>
        <button
          className="mascot-button"
          aria-label="打开SysAgent管家"
          title="点击打开主页 · 按住拖动 · 右键退出"
          onPointerDown={(event) => {
            if (event.button !== 0 || drag.current) return;
            suppressClick.current = false;
            drag.current = { id: event.pointerId, x: event.screenX, y: event.screenY, moved: false };
            window.sysomDesktop!.beginDrag(event.screenX, event.screenY);
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const current = drag.current;
            if (!current || current.id !== event.pointerId) return;
            if (Math.hypot(event.screenX - current.x, event.screenY - current.y) >= 6) {
              current.moved = true;
              setDragging(true);
            }
            if (current.moved) window.sysomDesktop!.moveDrag(event.screenX, event.screenY);
          }}
          onPointerUp={finishDrag}
          onPointerCancel={finishDrag}
          onLostPointerCapture={() => {
            drag.current = null;
            setDragging(false);
            window.sysomDesktop!.endDrag();
          }}
          onClick={(event) => {
            event.preventDefault();
            if (suppressClick.current && event.detail !== 0) {
              suppressClick.current = false;
              return;
            }
            window.sysomDesktop!.openHome();
          }}
        >
          <span className="mascot-halo" aria-hidden="true" />
          <Mascot />
          <span className="mascot-status" aria-hidden="true" />
        </button>
        <span className="mascot-name" aria-hidden="true">SysAgent</span>
      </div>
    </div>
  );
}

export default function DesktopDemo() {
  const nativeDesktop = window.sysomDesktop?.isElectron === true;
  const [homeOpen, setHomeOpen] = useState(nativeDesktop);
  const [homeMounted, setHomeMounted] = useState(nativeDesktop);
  const [homeRequest, setHomeRequest] = useState(0);
  const [position, setPosition] = useState(() =>
    clampPosition({ x: window.innerWidth - 140, y: window.innerHeight - 180 }),
  );
  const [dragging, setDragging] = useState(false);
  const [hasDragged, setHasDragged] = useState(false);
  const [healthState, setHealthState] = useState(() => createInitialState(detectGpu()));
  const [snapshotLoading, setSnapshotLoading] = useState(true);
  const [snapshotError, setSnapshotError] = useState('');
  const [alert, setAlert] = useState<ResourceAlert | null>(null);
  const [pulseRevision, setPulseRevision] = useState<number | null>(null);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [demoTarget, setDemoTarget] = useState<AlertTarget>('energy');
  const [demoStage, setDemoStage] = useState<DemoStage>('idle');
  const [demoError, setDemoError] = useState('');
  const [mutationBusy, setMutationBusy] = useState(false);
  const alive = useRef(true);
  const polling = useRef(false);
  const previousSnapshot = useRef<HealthState | null>(null);
  const stopToken = useRef(0);
  const demoTimer = useRef<number | null>(null);
  const demoMutationBusy = useRef(false);
  const launcherButton = useRef<HTMLButtonElement | null>(null);
  const desktopWindow = useRef<HTMLDivElement | null>(null);
  const suppressClick = useRef(false);
  const previouslyOpen = useRef(false);
  const dragState = useRef<DragState | null>(null);
  const refreshSnapshot = useCallback(async (refresh = true) => {
    const snapshot = await fetchHealthSnapshot(refresh);
    if (alive.current) {
      setHealthState((current) => snapshot.revision >= current.revision ? snapshot : current);
      setSnapshotLoading(false);
      setSnapshotError('');
    }
    return snapshot;
  }, []);

  useEffect(() => {
    alive.current = true;
    const poll = async () => {
      if (!polling.current) {
        polling.current = true;
        try {
          await refreshSnapshot(false);
        } catch (error) {
          if (alive.current && !previousSnapshot.current) {
            setSnapshotError(error instanceof Error ? error.message : '快照加载失败');
            setSnapshotLoading(false);
          }
        } finally {
          polling.current = false;
        }
      }
    };
    poll();
    const interval = window.setInterval(() => {
      if (nativeDesktop || !document.hidden) poll();
    }, 1500);
    return () => {
      alive.current = false;
      window.clearInterval(interval);
      stopToken.current++;
      if (demoTimer.current !== null) window.clearTimeout(demoTimer.current);
    };
  }, [refreshSnapshot, nativeDesktop]);

  useEffect(() => {
    if (!nativeDesktop) return;
    const desktop = window.sysomDesktop!;
    const removeOpen = desktop.onOpenHome(() => {
      setHomeMounted(true);
      setHomeOpen(true);
      setHomeRequest((current) => current + 1);
    });
    const removeCollapsed = desktop.onCollapsed(() => setHomeOpen(false));
    const removeDismiss = desktop.onDismissAlert(() => {
      setAlert(null);
      setPulseRevision(null);
    });
    return () => { removeOpen(); removeCollapsed(); removeDismiss(); };
  }, [nativeDesktop]);

  useEffect(() => {
    if (!nativeDesktop) return;
    window.sysomDesktop!.updateLauncherState({
      revision: healthState.revision,
      mode: healthState.mode,
      pulseRevision,
      items: alert?.items.flatMap((item) => {
        const usage = targetUsage(healthState, item.target);
        return usage === null ? [] : [{ label: item.label, usage }];
      }) ?? [],
    });
  }, [nativeDesktop, healthState, alert, pulseRevision]);

  useEffect(() => {
    if (snapshotLoading || snapshotError) return;
    const previous = previousSnapshot.current;
    previousSnapshot.current = healthState;
    if (!previous || previous.mode !== healthState.mode) {
      setAlert(null);
      setPulseRevision(null);
      return;
    }
    if (previous.revision === healthState.revision) return;
    const items = stateTargets(healthState).flatMap((target) => {
      const before = targetUsage(previous, target.id);
      const usage = targetUsage(healthState, target.id);
      return before !== null && usage !== null && before <= 90 && usage > 90
        ? [{ target: target.id, label: target.label, usage }] : [];
    });
    if (items.length) {
      setAlert({ revision: healthState.revision, items });
      setPulseRevision(healthState.revision);
    }
  }, [healthState, snapshotLoading, snapshotError]);

  useEffect(() => {
    if (pulseRevision === null) return;
    const timer = window.setTimeout(() => setPulseRevision(null), 1500);
    return () => window.clearTimeout(timer);
  }, [pulseRevision]);

  const collected = healthState.mode === 'collected';
  useEffect(() => {
    if (!collected) return;
    stopToken.current++;
    if (demoTimer.current !== null) window.clearTimeout(demoTimer.current);
    setDemoStage('idle');
    setControlsOpen(false);
  }, [collected]);
  const demoRunning = demoStage === 'preparing' || demoStage === 'waiting' || demoStage === 'raising';

  async function updateDemoSample(target: AlertTarget, usage: 80 | 96, token: number) {
    const snapshot = await refreshSnapshot(false);
    if (token !== stopToken.current || !alive.current || snapshot.mode === 'collected') return;
    await setAlertSample(target, usage, snapshot.revision);
    return refreshSnapshot(false);
  }

  async function startDemo() {
    if (collected || demoRunning || mutationBusy || snapshotLoading || snapshotError || demoMutationBusy.current) return;
    const token = ++stopToken.current;
    const target = demoTarget;
    setDemoError('');
    setAlert(null);
    setPulseRevision(null);
    setDemoStage('preparing');
    demoMutationBusy.current = true;
    try {
      await updateDemoSample(target, 80, token);
      if (token !== stopToken.current || !alive.current) return;
      setDemoStage('waiting');
      demoTimer.current = window.setTimeout(async () => {
        if (token !== stopToken.current || !alive.current) return;
        setDemoStage('raising');
        demoMutationBusy.current = true;
        try {
          await updateDemoSample(target, 96, token);
          if (token === stopToken.current && alive.current) setDemoStage('done');
        } catch (error) {
          if (alive.current && token === stopToken.current) {
            setDemoError(error instanceof Error ? error.message : '演示更新失败');
            setDemoStage('idle');
          }
        } finally {
          demoMutationBusy.current = false;
        }
      }, 2400);
    } catch (error) {
      if (alive.current && token === stopToken.current) {
        setDemoError(error instanceof Error ? error.message : '演示更新失败');
        setDemoStage('idle');
      }
    } finally {
      demoMutationBusy.current = false;
    }
  }

  function stopDemo() {
    stopToken.current++;
    if (demoTimer.current !== null) window.clearTimeout(demoTimer.current);
    setDemoStage('idle');
    setDemoError('已停止后续演示，保留当前样本值；不会自动优化或清理。');
  }

  useEffect(() => {
    const resize = () => setPosition((current) => clampPosition(current));
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  useEffect(() => {
    if (homeOpen) {
      desktopWindow.current?.querySelector<HTMLButtonElement>('[aria-label="关闭主页并收回悬浮球"]')?.focus({ preventScroll: true });
    } else if (previouslyOpen.current) {
      launcherButton.current?.focus({ preventScroll: true });
    }
    previouslyOpen.current = homeOpen;
  }, [homeOpen]);

  function dismissAlert() {
    setAlert(null);
    setPulseRevision(null);
    if (homeOpen) {
      desktopWindow.current?.querySelector<HTMLButtonElement>('[aria-label="关闭主页并收回悬浮球"]')?.focus({ preventScroll: true });
    } else {
      launcherButton.current?.focus({ preventScroll: true });
    }
  }

  function openHome() {
    setHomeMounted(true);
    setHomeOpen(true);
    setHomeRequest((current) => current + 1);
  }

  function startDrag(event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || dragState.current) return;
    suppressClick.current = false;
    dragState.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      origin: position,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveDrag(event: PointerEvent<HTMLButtonElement>) {
    const drag = dragState.current;
    if (!drag || drag.id !== event.pointerId) return;
    const deltaX = event.clientX - drag.x;
    const deltaY = event.clientY - drag.y;
    if (Math.hypot(deltaX, deltaY) >= 6) {
      drag.moved = true;
      setDragging(true);
      setHasDragged(true);
    }
    if (drag.moved) setPosition(clampPosition({ x: drag.origin.x + deltaX, y: drag.origin.y + deltaY }));
  }

  function finishDrag(event: PointerEvent<HTMLButtonElement>) {
    if (!dragState.current || dragState.current.id !== event.pointerId) return;
    suppressClick.current = dragState.current.moved || event.type === 'pointercancel';
    dragState.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  return (
    <div className={`desktop-demo ${homeOpen ? 'home-open' : 'home-closed'}`}>
      <div className="desktop-wallpaper" aria-hidden="true">
        <div className="wallpaper-shape one" />
        <div className="wallpaper-shape two" />
        <div className="wallpaper-shape three" />
      </div>
      {!homeOpen && (
        <>
          <div className="desktop-demo-label">
            <span className="desktop-demo-dot" />
            SysAgent管家
            <small>网页内桌面模拟</small>
          </div>
          <div className="desktop-demo-caption">
            <MousePointer2 size={13} />
            <span>拖动角色调整位置 · 点击打开管家</span>
          </div>
        </>
      )}
      {homeMounted && (
        <div className="desktop-window" ref={desktopWindow} hidden={!homeOpen}>
          <App
            active={homeOpen}
            onCollapse={() => {
              setHomeOpen(false);
              if (nativeDesktop) window.sysomDesktop!.hideToLauncher();
            }}
            healthState={healthState}
            snapshotLoading={snapshotLoading}
            snapshotError={snapshotError}
            onRefresh={refreshSnapshot}
            demoRunning={demoRunning}
            mutationBusy={mutationBusy}
            onActionBusy={setMutationBusy}
            homeRequest={homeRequest}
          />
        </div>
      )}
      {(!nativeDesktop || homeOpen) && (!homeOpen || alert) && (
        <div
          className={`mascot-launcher ${dragging ? 'dragging' : ''} ${pulseRevision !== null ? 'alert-pulse' : ''} ${alert ? 'has-alert' : ''}`}
          data-alert-revision={alert?.revision}
          style={{ left: position.x, top: position.y }}
        >
          {!alert && !hasDragged && !dragging && (
            <div className={`mascot-greeting ${position.x < 205 ? 'right' : 'left'}`} aria-hidden="true">
              <strong>你好，我是 SysAgent管家。</strong>
              <span>点我看看本机状态<ArrowUpRight size={12} /></span>
            </div>
          )}
          {alert && (
            <div className={`mascot-alert-card ${position.x < 260 ? 'right' : 'left'} ${position.y < 230 ? 'below' : 'above'}`} role="alert">
              <div className="mascot-alert-heading">
                <BellRing size={15} />
                <strong>资源阈值告警{collected ? ' · 本机采集' : ' · Demo'}</strong>
                <button aria-label="关闭资源告警" onClick={dismissAlert}><X size={13} /></button>
              </div>
              {alert.items.map((item) => {
                const usage = targetUsage(healthState, item.target);
                if (usage === null) return null;
                return (
                  <p key={item.target}>
                    <span>{item.label}</span>
                    <b className={usage > 90 ? 'hot' : 'recovered'}>{usage}%{usage <= 90 && ' · 已回落'}</b>
                  </p>
                );
              })}
              <small>阈值 &gt;90% · 当前快照 v{healthState.revision}。不会自动清理任务。</small>
              <button className="mascot-alert-open" onClick={openHome}>查看本机健康<ArrowUpRight size={12} /></button>
            </div>
          )}
          <button
            ref={launcherButton}
            className="mascot-button"
            aria-label="打开SysAgent管家"
            title="点击打开 SysAgent管家，按住可拖动"
            onPointerDown={startDrag}
            onPointerMove={moveDrag}
            onPointerUp={finishDrag}
            onPointerCancel={finishDrag}
            onLostPointerCapture={() => {
              dragState.current = null;
              setDragging(false);
            }}
            onClick={(event) => {
              event.preventDefault();
              if (suppressClick.current && event.detail !== 0) {
                suppressClick.current = false;
                return;
              }
              openHome();
            }}
          >
            <span className="mascot-halo" aria-hidden="true" />
            <Mascot />
            <span className="mascot-status" aria-hidden="true" />
          </button>
          <span className="mascot-name" aria-hidden="true">SysAgent</span>
        </div>
      )}
      {!collected && <div className="resource-demo-controls">
        <button className="resource-demo-toggle" aria-expanded={controlsOpen} onClick={() => setControlsOpen((current) => !current)}>
          <BellRing size={14} />动态告警演示
        </button>
        {controlsOpen && (
          <div className="resource-demo-panel">
            <div className="resource-demo-title">
              <strong>90% 阈值越界演示</strong>
              <button aria-label="关闭演示设置" onClick={() => setControlsOpen(false)}><X size={14} /></button>
            </div>
            <p>先设为 80%，等待约 2 秒后升至 96%；角色放大抖动并弹出提示。</p>
            <label>
              检查对象
              <select
                aria-label="告警演示对象"
                value={demoTarget}
                disabled={demoRunning}
                onChange={(event) => {
                  setDemoTarget(event.target.value as AlertTarget);
                  setDemoStage('idle');
                  setDemoError('');
                }}
              >
                {stateTargets(healthState).map((target) => <option key={target.id} value={target.id}>{target.label}</option>)}
              </select>
            </label>
            <div className="resource-demo-reading">
              <span>当前样本</span>
              <b>{targetUsage(healthState, demoTarget) === null ? '不可用' : `${targetUsage(healthState, demoTarget)}%`}</b>
              <small>v{healthState.revision}</small>
            </div>
            {demoStage !== 'idle' && (
              <div className="resource-demo-stage" role="status">
                {demoStage === 'done' ? <Check size={14} /> : <LoaderCircle size={14} className="spinning" />}
                {demoStage === 'preparing'
                  ? '先恢复到正常样本 80%'
                  : demoStage === 'waiting'
                    ? '正常 80% · 等待资源升高…'
                    : demoStage === 'raising'
                      ? '正在升至 96%…'
                      : '演示完成 · 超过阈值已告警'}
              </div>
            )}
            {demoError && <p className="resource-demo-error" role="status">{demoError}</p>}
            <div className="resource-demo-actions">
              <button onClick={startDemo} disabled={demoRunning || mutationBusy || snapshotLoading || !!snapshotError}>
                <Play size={13} />{demoStage === 'done' ? '再次演示' : '开始演示'}
              </button>
              {demoRunning && <button onClick={stopDemo}><Square size={12} />停止</button>}
            </div>
            <small>仅改变 Demo 样本，能耗为预算占比；非真实监控数据。</small>
          </div>
        )}
      </div>}
    </div>
  );
}
