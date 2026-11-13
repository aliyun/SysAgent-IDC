import { useEffect, useId, useRef, useState } from 'react';
import { ChevronRight, Clock3, History, LoaderCircle, Pause, Play, Power } from 'lucide-react';
import { Modal } from './components';
import { localTime } from '../agent-diagnostics';
import { fetchCollectorStatus, setCollectorEnabled, setInspectionInterval, type CollectorStatus } from './idc-client';

const intervalPresets = [1, 5, 15, 30, 60, 360, 720, 1440];

function formatInterval(minutes: number) {
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return hours ? `${hours}小时${remainder ? `${remainder}分钟` : ''}` : `${minutes}分钟`;
}

function formatInspectionTime(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return localTime(value);
}

function InspectionIntervalModal({ status, onSave, onClose }: {
  status: CollectorStatus; onSave: (minutes: number) => Promise<void>; onClose: () => void;
}) {
  const currentMinutes = status.inspection_interval_minutes ?? 5;
  // Initialize only when the modal opens; status polls must not reset an edited draft.
  const [choice, setChoice] = useState<number | 'custom'>(() => intervalPresets.includes(currentMinutes) ? currentMinutes : 'custom');
  const [hours, setHours] = useState(() => String(Math.floor(currentMinutes / 60)));
  const [minutes, setMinutes] = useState(() => String(currentMinutes % 60));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const savingRef = useRef(false);
  const inputId = useId();
  const hourValue = Number(hours);
  const minuteValue = Number(minutes);
  const total = choice === 'custom' ? hourValue * 60 + minuteValue : choice;
  const invalidFields = choice === 'custom' && (!hours.trim() || !minutes.trim() || !Number.isInteger(hourValue) ||
    !Number.isInteger(minuteValue) || hourValue < 0 || hourValue > 24 || minuteValue < 0 || minuteValue > 59);
  const validationError = invalidFields ? '小时需为 0–24 的整数，分钟需为 0–59 的整数。' :
    total < 1 || total > 1440 ? '合计须为 1 分钟至 24 小时；24 小时时分钟必须为 0。' : '';
  const unavailable = status.mode === 'offline-demo' || !status.installed;
  const message = error || (unavailable ? '当前无法设置巡检周期；离线演示不执行本地采集。' : validationError);

  function close() {
    if (!savingRef.current) onClose();
  }

  async function save() {
    if (savingRef.current || unavailable || validationError || total === currentMinutes) return;
    savingRef.current = true;
    setSaving(true);
    setError('');
    try {
      await onSave(total);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '巡检周期保存失败，请重试');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  return <Modal title="设置巡检周期" subtitle="默认 5 分钟，可设置 1 分钟至 24 小时" onClose={close}>
    <form className="sh-interval-form" noValidate aria-busy={saving} onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <fieldset disabled={saving || unavailable}>
        <legend>选择巡检周期</legend>
        <div className="sh-interval-presets">
          {intervalPresets.map(value => <button key={value} type="button" aria-pressed={choice === value}
            onClick={() => { setChoice(value); setError(''); }}>
            {formatInterval(value)}{value === 5 && <small>默认</small>}
          </button>)}
          <button type="button" className="sh-interval-custom-choice" aria-pressed={choice === 'custom'}
            onClick={() => { setChoice('custom'); setError(''); }}>自定义</button>
        </div>
        {choice === 'custom' && <div className="sh-interval-inputs">
          <label htmlFor={`${inputId}-hours`}>小时
            <input id={`${inputId}-hours`} type="number" min={0} max={24} step={1} inputMode="numeric" required
              value={hours} aria-invalid={!!validationError} aria-describedby={`${inputId}-hint ${inputId}-error`}
              onChange={(event) => { setHours(event.target.value); setError(''); }} />
          </label>
          <label htmlFor={`${inputId}-minutes`}>分钟
            <input id={`${inputId}-minutes`} type="number" min={0} max={59} step={1} inputMode="numeric" required
              value={minutes} aria-invalid={!!validationError} aria-describedby={`${inputId}-hint ${inputId}-error`}
              onChange={(event) => { setMinutes(event.target.value); setError(''); }} />
          </label>
        </div>}
        <p className="sh-interval-hint" id={`${inputId}-hint`}>合计 1–1440 分钟，仅支持整数；24 小时时分钟须为 0。</p>
      </fieldset>
      <p className="sh-interval-note">保存后重新计时；暂停采集或退出应用后停止巡检。</p>
      <p id={`${inputId}-error`} className="sh-interval-error" role="alert">{message}</p>
      <div className="modal-actions sh-interval-actions">
        <button type="button" className="button secondary" disabled={saving} onClick={close}>取消</button>
        <button type="submit" className="button primary" disabled={saving || unavailable || !!validationError || total === currentMinutes}>
          {saving && <LoaderCircle size={14} className="spinning" />}{saving ? '保存中' : '保存'}
        </button>
      </div>
    </form>
  </Modal>;
}

export function CollectionStatus({ open, onClose, lastInspectionAt, busy, onRefresh, onBusyChange, onEnabledChange }: {
  open: boolean; onClose: () => void; lastInspectionAt: string | null;
  busy: boolean; onRefresh: (refresh?: boolean) => Promise<unknown>; onBusyChange: (busy: boolean) => void; onEnabledChange: (enabled: boolean) => void;
}) {
  const [status, setStatus] = useState<CollectorStatus | null>(null);
  const [error, setError] = useState('');
  const [acting, setActing] = useState(false);
  const [intervalOpen, setIntervalOpen] = useState(false);
  const inFlight = useRef(false);
  const statusVersion = useRef(0);
  useEffect(() => {
    let mounted = true;
    let pending = false;
    const poll = async () => {
      if (pending || inFlight.current) return;
      pending = true;
      const version = statusVersion.current;
      try {
        const next = await fetchCollectorStatus();
        if (mounted && version === statusVersion.current) { setStatus(next); setError(''); }
      } catch {
        if (mounted && version === statusVersion.current) setError('巡检配置暂不可用，请稍后重试。');
      } finally { pending = false; }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 1500);
    return () => { mounted = false; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (status) onEnabledChange(status.mode === 'offline-demo' || (status.installed && status.enabled));
  }, [status, onEnabledChange]);

  async function toggleCollector() {
    if (inFlight.current || intervalOpen || !status || !status.installed || status.mode === 'offline-demo') return;
    inFlight.current = true;
    statusVersion.current += 1;
    setActing(true);
    setError('');
    onBusyChange(true);
    try {
      const next = await setCollectorEnabled(!status.enabled);
      setStatus(next);
      if (next.enabled) await onRefresh();
      setStatus(await fetchCollectorStatus());
    } catch {
      setError('采集启停失败，请重试。');
      try { setStatus(await fetchCollectorStatus()); } catch {}
    } finally {
      inFlight.current = false;
      setActing(false);
      onBusyChange(false);
    }
  }
  async function saveInterval(minutes: number) {
    if (inFlight.current) throw new Error('采集设置正在处理中，请稍后重试');
    inFlight.current = true;
    statusVersion.current += 1;
    setActing(true);
    try {
      const next = await setInspectionInterval(minutes);
      setStatus(next);
      setError('');
    } catch {
      throw new Error('巡检周期保存失败，请重试。');
    } finally {
      inFlight.current = false;
      setActing(false);
    }
  }

  if (!open) return null;
  if (intervalOpen && status) return <InspectionIntervalModal status={status} onSave={saveInterval} onClose={() => setIntervalOpen(false)} />;

  const collecting = status?.phase === 'collecting' || status?.phase === 'submitting';
  const offline = status?.mode === 'offline-demo';
  const unavailable = !status?.installed || offline;
  const nextInspection = formatInspectionTime(status?.next_inspection_at ?? null);
  const scheduleLabel = !status ? '正在读取' : unavailable ? '暂不可用' : !status.enabled ? '已暂停' :
    nextInspection || (collecting ? '巡检完成后安排' : '等待安排');
  const previousInspection = formatInspectionTime(status?.last_task?.profile === 'inspection' ? status.last_task.collected_at : lastInspectionAt) || '暂无巡检';

  return <Modal title="巡检配置" onClose={() => { if (!inFlight.current) onClose(); }}>
    <section className="sh-inspection-config" aria-label="巡检设置">
      <div className="sh-inspection-control">
        <span><Power size={15} />启停状态</span>
        <button type="button" className="sh-inspection-toggle" disabled={unavailable || acting || (busy && !status?.enabled)} onClick={() => { void toggleCollector(); }}>
          {acting ? <LoaderCircle size={15} className="spinning" /> : status?.enabled ? <Pause size={15} /> : <Play size={15} />}
          {status?.enabled ? '暂停巡检' : '开启巡检'}
        </button>
      </div>
      <div className="sh-inspection-setting">
        <span><Clock3 size={15} />巡检周期</span>
        <button type="button" disabled={unavailable || acting} aria-haspopup="dialog" aria-label="设置巡检周期" onClick={() => setIntervalOpen(true)}>
          {formatInterval(status?.inspection_interval_minutes ?? 5)}<ChevronRight size={14} />
        </button>
      </div>
      <div className="sh-inspection-setting">
        <span><Clock3 size={15} />下次巡检</span>
        <time dateTime={status?.next_inspection_at ?? undefined}>{scheduleLabel}</time>
      </div>
      <div className="sh-inspection-setting">
        <span><History size={15} />上次巡检</span>
        <time>{previousInspection}</time>
      </div>
    </section>
    {error && <p className="sh-inspection-config-error" role="alert">{error}</p>}
  </Modal>;
}
