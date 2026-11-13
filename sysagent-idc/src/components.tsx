import { useEffect, useId, useRef } from 'react';
import type { MouseEventHandler, ReactNode } from 'react';
import { ArrowUpRight, Check, ChevronRight, Cpu, Monitor, Server, X } from 'lucide-react';
import type { DeviceKind, DeviceStatus } from './data';

export function MascotFigure() {
  const id = useId().replace(/:/g, '');
  return (
    <>
      <defs>
        <linearGradient id={`${id}-head`} x1="0" y1="0" x2="1" y2="1">
          <stop stopColor="#9dabe3" />
          <stop offset=".5" stopColor="#7e8ecc" />
          <stop offset="1" stopColor="#6475b2" />
        </linearGradient>
        <linearGradient id={`${id}-body`} x1="0" y1="0" x2="1" y2="1">
          <stop stopColor="#95a3d7" />
          <stop offset="1" stopColor="#7485c0" />
        </linearGradient>
        <linearGradient id={`${id}-side`} x1="0" y1="0" x2="1" y2="1">
          <stop stopColor="#7180b3" />
          <stop offset="1" stopColor="#5e6da0" />
        </linearGradient>
        <pattern id={`${id}-texture`} width="8" height="8" patternUnits="userSpaceOnUse">
          <circle cx="2" cy="3" r=".7" fill="#fff" opacity=".14" />
          <circle cx="6" cy="6" r=".65" fill="#4b5685" opacity=".1" />
        </pattern>
      </defs>
      <ellipse cx="87" cy="170" rx="48" ry="8" fill="#475179" opacity=".14" />
      <path d="M66 147c-5 5-10 14-8 20 4 4 17 5 27 2l4-20z" fill="#333641" />
      <path d="M97 149l2 18c6 5 21 4 27 0 1-5-5-15-12-19z" fill="#3a3b48" />
      <path d="M31 89c-10 2-15 9-14 18l2 31c2 14 17 21 33 19l17-12-9-53z" fill={`url(#${id}-side)`} />
      <path d="M34 84c21-8 64-7 91 3 20 7 27 22 24 40-3 21-22 32-47 32l-48-3c-22-2-30-17-29-38 0-17 1-30 9-34z" fill={`url(#${id}-body)`} />
      <path d="M47 29c25-13 63-11 92 1 15 6 19 18 15 33l-6 25c-2 10-11 16-27 17L64 95C42 92 28 77 30 58c1-13 6-23 17-29z" fill={`url(#${id}-head)`} />
      <path d="M49 33c22-10 55-11 83-2" fill="none" stroke="#c0c9ed" strokeOpacity=".4" strokeWidth="3" strokeLinecap="round" />
      <path d="M47 29c25-13 63-11 92 1 15 6 19 18 15 33l-6 25c-2 10-11 16-27 17L64 95C42 92 28 77 30 58c1-13 6-23 17-29zM34 84c21-8 64-7 91 3 20 7 27 22 24 40-3 21-22 32-47 32l-48-3c-22-2-30-17-29-38 0-17 1-30 9-34z" fill={`url(#${id}-texture)`} />
      <ellipse cx="102" cy="64" rx="13" ry="17" fill="#eceaf0" transform="rotate(-7 102 64)" />
      <ellipse cx="130" cy="69" rx="12" ry="16" fill="#f0edf1" transform="rotate(-5 130 69)" />
      <ellipse cx="103" cy="67" rx="6.4" ry="9" fill="#383640" />
      <ellipse cx="130" cy="72" rx="6.1" ry="8.5" fill="#383640" />
      <circle cx="101" cy="64" r="2" fill="#fff" opacity=".6" />
      <circle cx="128" cy="69" r="1.8" fill="#fff" opacity=".6" />
      <path d="M109 95q6 5 12 1" fill="none" stroke="#515e90" strokeWidth="2" strokeLinecap="round" opacity=".4" />
      <path d="M45 123q31 11 70 6" fill="none" stroke="#c7d0ee" strokeWidth="2.5" strokeLinecap="round" opacity=".16" />
    </>
  );
}

export function MascotLogo({ className = 'mascot-logo' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 1024 1024" aria-hidden="true">
      <circle cx="512" cy="512" r="474" fill="#f3f5fa" stroke="#839bd5" strokeWidth="40" />
      <g transform="translate(100 74) scale(4.7)">
        <MascotFigure />
      </g>
      <circle cx="797" cy="770" r="58" fill="#60bdaa" stroke="#f9fafc" strokeWidth="26" />
    </svg>
  );
}

export function Logo({ small = false }: { small?: boolean }) {
  return (
    <span className={`brand-mark ${small ? 'small' : ''}`} aria-hidden="true">
      <MascotLogo />
    </span>
  );
}

interface DeviceIconProps {
  kind: DeviceKind;
  large?: boolean;
}

export function DeviceIcon({ kind, large = false }: DeviceIconProps) {
  const Icon = kind === 'server' ? Server : kind === 'mini' ? Monitor : Cpu;
  return (
    <span className={`device-icon ${kind} ${large ? 'large' : ''}`}>
      <Icon size={large ? 25 : 19} strokeWidth={1.7} />
    </span>
  );
}

interface StatusPillProps {
  status: DeviceStatus | 'running';
  label?: string;
}

export function StatusPill({ status, label }: StatusPillProps) {
  const labels = {
    healthy: '运行正常',
    warning: '待关注',
    offline: '离线',
    running: '执行中',
  };
  return (
    <span className={`status-pill ${status}`}>
      <i />
      {label || labels[status]}
    </span>
  );
}

interface MeterProps {
  value: number | null;
  muted?: boolean;
}

export function Meter({ value, muted = false }: MeterProps) {
  if (value === null) return <span className="no-gpu">{muted ? '—' : '不可用'}</span>;
  return (
    <div className={`meter ${muted ? 'muted' : ''}`}>
      <span className="meter-track">
        <i style={{ width: `${value}%` }} className={value > 80 ? 'amber' : ''} />
      </span>
      <span className="mono">{muted ? '—' : `${value}%`}</span>
    </div>
  );
}

interface SparklineProps {
  values: number[];
  color?: string;
}

export function Sparkline({ values, color = '#5877ed' }: SparklineProps) {
  const points = values
    .map((value, index) => `${(index * 80) / (values.length - 1)},${32 - value * 0.3}`)
    .join(' ');
  return (
    <svg className="sparkline" viewBox="0 0 80 34" aria-hidden="true">
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

interface ResourceChartProps {
  values: number[];
  color?: string;
  label?: string;
}

export function ResourceChart({
  values,
  color = '#5277ed',
  label = 'GPU 利用率',
}: ResourceChartProps) {
  const gradientId = useId().replace(/:/g, '');
  const points = values
    .map((value, index) => `${38 + (index * 590) / (values.length - 1)},${156 - value * 1.32}`)
    .join(' ');
  const areaPoints = `38,156 ${points} 628,156`;
  return (
    <div className="resource-chart">
      <svg
        viewBox="0 0 660 193"
        role="img"
        aria-label={`${label}过去 30 分钟的模拟变化趋势`}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.18" />
            <stop offset="100%" stopColor={color} stopOpacity="0.015" />
          </linearGradient>
        </defs>
        {[0, 25, 50, 75, 100].map((value) => (
          <g key={value}>
            <line
              x1="38"
              y1={156 - value * 1.32}
              x2="628"
              y2={156 - value * 1.32}
              stroke="#e9edf4"
              strokeDasharray="3 4"
            />
            <text x="27" y={160 - value * 1.32} textAnchor="end">
              {value === 100 ? '100%' : value}
            </text>
          </g>
        ))}
        <polygon points={areaPoints} fill={`url(#${gradientId})`} />
        <polyline
          points={points}
          fill="none"
          stroke={color}
          strokeWidth="2.5"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <circle
          cx="628"
          cy={156 - values[values.length - 1] * 1.32}
          r="4"
          fill={color}
          stroke="white"
          strokeWidth="2"
        />
        {['14:00', '14:05', '14:10', '14:15', '14:20', '14:25', '14:30'].map(
          (time, index) => (
            <text key={time} x={38 + (index * 590) / 6} y="183" textAnchor="middle">
              {time}
            </text>
          ),
        )}
      </svg>
    </div>
  );
}

interface HealthRingProps {
  score: number;
  compact?: boolean;
}

export function HealthRing({ score, compact = false }: HealthRingProps) {
  return (
    <div className={`health-ring ${compact ? 'compact' : ''}`}>
      <svg viewBox="0 0 132 132" aria-hidden="true">
        <circle cx="66" cy="66" r="55" fill="none" stroke="#e9f4ef" strokeWidth="9" />
        <circle
          cx="66"
          cy="66"
          r="55"
          fill="none"
          stroke="#29a887"
          strokeWidth="9"
          strokeDasharray={`${score * 3.456} 345.6`}
          strokeLinecap="round"
          transform="rotate(-90 66 66)"
        />
      </svg>
      <div>
        <strong>{score || '—'}</strong>
        <span>健康评分</span>
      </div>
    </div>
  );
}

interface PanelHeadingProps {
  title: ReactNode;
  eyebrow?: ReactNode;
  children?: ReactNode;
}

export function PanelHeading({ title, eyebrow, children }: PanelHeadingProps) {
  return (
    <div className="panel-heading">
      <div>
        <h2>{title}</h2>
        {eyebrow && <p>{eyebrow}</p>}
      </div>
      {children}
    </div>
  );
}

interface EmptyStateProps {
  title: ReactNode;
  description: ReactNode;
  children?: ReactNode;
}

export function EmptyState({ title, description, children }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <Monitor size={29} strokeWidth={1.5} />
      </div>
      <h3>{title}</h3>
      <p>{description}</p>
      {children}
    </div>
  );
}

interface ModalProps {
  title: ReactNode;
  subtitle?: ReactNode;
  children?: ReactNode;
  onClose: () => void;
  wide?: boolean;
}

export function Modal({ title, subtitle, children, onClose, wide = false }: ModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current!;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.showModal();
    return () => {
      dialog.close();
      document.body.style.overflow = overflow;
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className={`modal ${wide ? 'wide' : ''}`}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal-header">
        <div>
          <h2 id={titleId}>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <button className="icon-button" aria-label="关闭弹窗" onClick={onClose}>
          <X size={20} />
        </button>
      </div>
      <div className="modal-body">{children}</div>
    </dialog>
  );
}

interface TextLinkProps {
  children?: ReactNode;
  onClick?: MouseEventHandler<HTMLButtonElement>;
}

export function TextLink({ children, onClick }: TextLinkProps) {
  return (
    <button className="text-link" onClick={onClick}>
      {children}
      <ChevronRight size={15} />
    </button>
  );
}

interface ReportItemProps {
  title: ReactNode;
  description: ReactNode;
  warning?: boolean;
}

export function ReportItem({ title, description, warning = false }: ReportItemProps) {
  return (
    <div className={`report-item ${warning ? 'warning' : ''}`}>
      <span className="report-check">
        {warning ? <ArrowUpRight size={16} /> : <Check size={16} />}
      </span>
      <div>
        <strong>{title}</strong>
        <p>{description}</p>
      </div>
    </div>
  );
}

export function WorkspaceIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 4l8 4-8 4-8-4zM4 12l8 4 8-4M4 16l8 4 8-4"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
