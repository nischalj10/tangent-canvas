import React from 'react';
import { CircleAlert, LoaderCircle } from 'lucide-react';
import './steering-notice.css';

// Accepted steering is an ordinary user bubble, matching ChatGPT's transcript.
// Keep a notice only while delivery needs attention or has not been confirmed.
export default function SteeringNotice({ message }) {
  if (message.delivery !== 'steer') return null;
  const pending = message.deliveryStatus === 'sending';
  const failed = message.deliveryStatus === 'failed';
  const uncertain = message.deliveryStatus === 'uncertain';
  if (!pending && !failed && !uncertain) return null;
  const label = pending ? 'Sending…' : uncertain ? 'Delivery unconfirmed' : 'Not sent';
  return <div className={`steering-notice ${pending ? 'is-sending' : 'needs-attention'}`}
    data-testid={`steering-notice-${message.id}`} data-delivery-status={message.deliveryStatus}
    role={failed || uncertain ? 'alert' : 'status'} aria-live="polite">
    {pending ? <LoaderCircle size={12} className="spin" aria-hidden="true"/> : <CircleAlert size={12} aria-hidden="true"/>}
    <span>{label}</span>
    {uncertain && <span className="steering-notice-detail">Check the conversation before sending again.</span>}
  </div>;
}
