/**
 * ContinuityDashboard — Gamified medication adherence tracker.
 * Hardcoded mock data for hackathon demo — looks like months of real tracking.
 */

import './ContinuityDashboard.css';

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------
const SCORE        = 92;
const STREAK_DAYS  = 14;
const REFILL_DAYS  = 3;
const MEDICATION   = 'Tenofovir / Lamivudine / Dolutegravir';
const DOSE_TIME    = '08:00 daily';

// Last 7 days: 'taken' | 'late' | 'missed' | 'upcoming'
const WEEK_LOG: { day: string; status: 'taken' | 'late' | 'missed' | 'upcoming' }[] = [
  { day: 'Mon', status: 'taken' },
  { day: 'Tue', status: 'taken' },
  { day: 'Wed', status: 'taken' },
  { day: 'Thu', status: 'late'  },
  { day: 'Fri', status: 'taken' },
  { day: 'Sat', status: 'taken' },
  { day: 'Sun', status: 'taken' },
];

// Monthly heatmap — 28 days, mostly taken with a few late/missed
const MONTH_LOG: ('taken' | 'late' | 'missed')[] = [
  'taken','taken','taken','taken','taken','taken','taken',
  'taken','taken','late', 'taken','taken','taken','taken',
  'taken','taken','taken','taken','missed','taken','taken',
  'taken','taken','taken','late', 'taken','taken','taken',
];

const BADGES = [
  { icon: '🔥', label: '2-Week Streak',   earned: true  },
  { icon: '💯', label: '30-Day Perfect',  earned: false },
  { icon: '⭐', label: 'Early Bird',       earned: true  },
  { icon: '🏆', label: '90-Day Champion', earned: false },
];

const STATUS_LABEL = { taken: 'Taken', late: 'Late', missed: 'Missed', upcoming: 'Today' };
const STATUS_COLOR = { taken: '#16A34A', late: '#D97706', missed: '#DC2626', upcoming: '#2563EB' };

// SVG circle ring helpers
const R   = 44;
const C   = 2 * Math.PI * R;
const arc = (pct: number) => C - (pct / 100) * C;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function ContinuityDashboard() {
  return (
    <div className="cd-container">

      {/* ── Hero score card ─────────────────────────────────────────── */}
      <div className="cd-hero">
        <div className="cd-hero-left">
          <p className="cd-hero-label">Continuity Score</p>
          <div className="cd-ring-wrap">
            <svg className="cd-ring" viewBox="0 0 100 100" aria-hidden="true">
              {/* Track */}
              <circle cx="50" cy="50" r={R} fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth="8" />
              {/* Progress */}
              <circle
                cx="50" cy="50" r={R}
                fill="none"
                stroke="#fff"
                strokeWidth="8"
                strokeLinecap="round"
                strokeDasharray={C}
                strokeDashoffset={arc(SCORE)}
                transform="rotate(-90 50 50)"
                className="cd-ring-arc"
              />
            </svg>
            <div className="cd-ring-inner">
              <span className="cd-score-num">{SCORE}%</span>
              <span className="cd-score-sub">adherence</span>
            </div>
          </div>
        </div>

        <div className="cd-hero-right">
          <div className="cd-stat">
            <span className="cd-stat-icon">🔥</span>
            <div>
              <p className="cd-stat-val">{STREAK_DAYS} Days</p>
              <p className="cd-stat-lbl">Current streak</p>
            </div>
          </div>
          <div className="cd-stat">
            <span className="cd-stat-icon">📅</span>
            <div>
              <p className="cd-stat-val cd-refill-val">{REFILL_DAYS} Days</p>
              <p className="cd-stat-lbl">Until next refill</p>
            </div>
          </div>
          <div className="cd-stat">
            <span className="cd-stat-icon">💊</span>
            <div>
              <p className="cd-stat-val cd-dose-val">{DOSE_TIME}</p>
              <p className="cd-stat-lbl">Daily dose time</p>
            </div>
          </div>
        </div>
      </div>

      {/* ── Encouragement banner ────────────────────────────────────── */}
      <div className="cd-banner">
        <span className="cd-banner-icon">🌟</span>
        <p className="cd-banner-text">
          Great job staying consistent this month! You're in the top 15% of patients.
        </p>
      </div>

      {/* ── Medication info ─────────────────────────────────────────── */}
      <div className="cd-card">
        <p className="cd-card-label">Current medication</p>
        <p className="cd-med-name">{MEDICATION}</p>
        <div className="cd-refill-bar-wrap">
          <div className="cd-refill-bar">
            <div className="cd-refill-fill" style={{ width: `${((30 - REFILL_DAYS) / 30) * 100}%` }} />
          </div>
          <span className="cd-refill-text">{REFILL_DAYS} days left</span>
        </div>
      </div>

      {/* ── 7-day heatmap ───────────────────────────────────────────── */}
      <div className="cd-card">
        <p className="cd-card-label">This week</p>
        <div className="cd-week">
          {WEEK_LOG.map(({ day, status }) => (
            <div key={day} className="cd-day-col">
              <div
                className={`cd-day-dot cd-day-dot--${status}`}
                title={STATUS_LABEL[status]}
                aria-label={`${day}: ${STATUS_LABEL[status]}`}
              />
              <span className="cd-day-label">{day}</span>
            </div>
          ))}
        </div>
        <div className="cd-legend">
          {(['taken','late','missed'] as const).map(s => (
            <span key={s} className="cd-legend-item">
              <span className="cd-legend-dot" style={{ background: STATUS_COLOR[s] }} />
              {STATUS_LABEL[s]}
            </span>
          ))}
        </div>
      </div>

      {/* ── 28-day heatmap ──────────────────────────────────────────── */}
      <div className="cd-card">
        <p className="cd-card-label">Last 28 days</p>
        <div className="cd-month-grid">
          {MONTH_LOG.map((status, i) => (
            <div
              key={i}
              className={`cd-month-cell cd-month-cell--${status}`}
              title={`Day ${i + 1}: ${STATUS_LABEL[status]}`}
            />
          ))}
        </div>
        <div className="cd-month-stats">
          <span className="cd-mstat"><strong>{MONTH_LOG.filter(s => s === 'taken').length}</strong> taken</span>
          <span className="cd-mstat cd-mstat--late"><strong>{MONTH_LOG.filter(s => s === 'late').length}</strong> late</span>
          <span className="cd-mstat cd-mstat--missed"><strong>{MONTH_LOG.filter(s => s === 'missed').length}</strong> missed</span>
        </div>
      </div>

      {/* ── Badges ──────────────────────────────────────────────────── */}
      <div className="cd-card">
        <p className="cd-card-label">Achievements</p>
        <div className="cd-badges">
          {BADGES.map(b => (
            <div key={b.label} className={`cd-badge ${b.earned ? 'cd-badge--earned' : 'cd-badge--locked'}`}>
              <span className="cd-badge-icon">{b.earned ? b.icon : '🔒'}</span>
              <span className="cd-badge-label">{b.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Next dose reminder ──────────────────────────────────────── */}
      <div className="cd-reminder">
        <span className="cd-reminder-icon">⏰</span>
        <div>
          <p className="cd-reminder-title">Next dose reminder</p>
          <p className="cd-reminder-sub">Tomorrow at 08:00 — keep your streak going!</p>
        </div>
        <span className="cd-reminder-streak">🔥 {STREAK_DAYS}</span>
      </div>

    </div>
  );
}
