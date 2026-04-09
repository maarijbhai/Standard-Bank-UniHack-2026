/**
 * SkipQueue — Schedule a medication pickup and get a QR code for express collection.
 * Matches the ImpiloCare presentation design.
 */

import { useState } from 'react';
import QRCode from 'react-qr-code';
import './SkipQueue.css';

const API_BASE = (() => {
  const raw = import.meta.env.VITE_API_URL as string | undefined;
  return raw ? raw.replace(/\/$/, '') : '';
})();

// Demo clinics — in production these would come from the /clinics endpoint
const DEMO_CLINICS = [
  { id: 'delft-chc',       name: 'Delft Community Health Centre' },
  { id: 'gugulethu-chc',   name: 'Gugulethu CHC' },
  { id: 'mitchells-plain', name: "Mitchell's Plain CHC" },
  { id: 'khayelitsha-chc', name: 'Khayelitsha CHC' },
  { id: 'nyanga-clinic',   name: 'Nyanga Clinic' },
];

// Generate 30-minute slots from now for the next 4 hours
function generateSlots(): { label: string; iso: string }[] {
  const slots = [];
  const now   = new Date();
  // Round up to next 30-min boundary
  const start = new Date(now);
  start.setMinutes(now.getMinutes() < 30 ? 30 : 60, 0, 0);
  if (now.getMinutes() >= 30) start.setHours(start.getHours() + 1);

  for (let i = 0; i < 8; i++) {
    const t = new Date(start.getTime() + i * 30 * 60 * 1000);
    const h = t.getHours().toString().padStart(2, '0');
    const m = t.getMinutes().toString().padStart(2, '0');
    slots.push({ label: `${h}:${m}`, iso: t.toISOString() });
  }
  return slots;
}

interface BookingResult {
  bookingId:     string;
  clinicName:    string;
  pickupTime:    string;
  estimatedWait: string;
  instructions:  string[];
}

export default function SkipQueue() {
  const [clinicId,      setClinicId]      = useState(DEMO_CLINICS[0].id);
  const [selectedSlot,  setSelectedSlot]  = useState('');
  const [loading,       setLoading]       = useState(false);
  const [error,         setError]         = useState('');
  const [booking,       setBooking]       = useState<BookingResult | null>(null);

  const slots = generateSlots();

  const handleBook = async () => {
    if (!selectedSlot) { setError('Please select a pickup time.'); return; }
    setLoading(true);
    setError('');

    try {
      const clinic = DEMO_CLINICS.find(c => c.id === clinicId)!;
      const res    = await fetch(`${API_BASE}/skipqueue`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          clinicId:      clinic.id,
          clinicName:    clinic.name,
          preferredTime: selectedSlot,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.debug_error ?? data.error ?? `HTTP ${res.status}`);
      setBooking(data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const formatTime = (iso: string) => {
    try {
      return new Date(iso).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' });
    } catch { return iso; }
  };

  if (booking) {
    return (
      <div className="sq-container">
        <div className="sq-success-card">
          {/* Header */}
          <div className="sq-success-header">
            <span className="sq-check">✅</span>
            <div>
              <h2 className="sq-success-title">Booking Confirmed!</h2>
              <p className="sq-success-sub">Skip the queue — go straight to collection</p>
            </div>
          </div>

          {/* Clinic + time */}
          <div className="sq-info-row">
            <div className="sq-info-item">
              <span className="sq-info-label">🏥 Clinic</span>
              <span className="sq-info-val">{booking.clinicName}</span>
            </div>
            <div className="sq-info-item">
              <span className="sq-info-label">🕐 Pickup time</span>
              <span className="sq-info-val">{formatTime(booking.pickupTime)}</span>
            </div>
            <div className="sq-info-item">
              <span className="sq-info-label">⏱ Estimated wait</span>
              <span className="sq-info-val sq-wait">{booking.estimatedWait}</span>
            </div>
          </div>

          {/* QR Code */}
          <div className="sq-qr-section">
            <p className="sq-qr-label">Show this QR code at the express counter</p>
            <div className="sq-qr-wrapper">
              <QRCode
                value={booking.bookingId}
                size={180}
                bgColor="#ffffff"
                fgColor="#1E40AF"
                level="M"
              />
            </div>
            <p className="sq-booking-id">Booking ID: {booking.bookingId.slice(0, 8).toUpperCase()}</p>
          </div>

          {/* Instructions */}
          <div className="sq-instructions">
            <p className="sq-instructions-title">Collection Instructions</p>
            <ol className="sq-steps">
              {booking.instructions.map((step, i) => (
                <li key={i} className="sq-step">
                  <span className="sq-step-num">{i + 1}</span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
          </div>

          <button className="sq-new-btn" onClick={() => { setBooking(null); setSelectedSlot(''); }}>
            Book another slot
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="sq-container">
      <div className="sq-header">
        <span className="sq-icon">⏭️</span>
        <div>
          <h2 className="sq-title">SkipQueue</h2>
          <p className="sq-sub">Schedule your pickup — skip the wait</p>
        </div>
      </div>

      <div className="sq-card">
        {/* Clinic selector */}
        <label className="sq-label" htmlFor="sq-clinic">Select clinic</label>
        <select
          id="sq-clinic"
          className="sq-select"
          value={clinicId}
          onChange={e => setClinicId(e.target.value)}
        >
          {DEMO_CLINICS.map(c => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>

        {/* Time slot picker */}
        <label className="sq-label">Choose a 30-minute pickup window</label>
        <div className="sq-slots">
          {slots.map(slot => (
            <button
              key={slot.iso}
              className={`sq-slot ${selectedSlot === slot.iso ? 'sq-slot--active' : ''}`}
              onClick={() => { setSelectedSlot(slot.iso); setError(''); }}
            >
              {slot.label}
            </button>
          ))}
        </div>

        {error && <p className="sq-error" role="alert">{error}</p>}

        <button
          className="sq-book-btn"
          onClick={handleBook}
          disabled={loading || !selectedSlot}
        >
          {loading ? 'Booking…' : '⏭️ Book My Slot'}
        </button>
      </div>

      {/* How it works */}
      <div className="sq-how">
        <p className="sq-how-title">How SkipQueue works</p>
        <div className="sq-how-steps">
          {[
            { icon: '📅', text: 'Choose your clinic and pickup time' },
            { icon: '📱', text: 'Get a QR code — your medication is pre-prepared' },
            { icon: '🚀', text: 'Walk in, scan, collect in under 10 minutes' },
          ].map((s, i) => (
            <div key={i} className="sq-how-step">
              <span className="sq-how-icon">{s.icon}</span>
              <span className="sq-how-text">{s.text}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
