import type { Action, Status } from './api.ts';

export type View = {
  title: string;
  text?: string;
  button?: { action: Action | null; label: string };
};

export function view(s: Status, paying: boolean): View {
  if (s.hold && paying) {
    return {
      title: 'Confirming your payment...',
      text: 'This usually takes a few seconds. Your pair stays reserved meanwhile.',
      button: { action: null, label: 'Processing payment...' },
    };
  }
  if (s.hold) {
    return {
      title: 'Your pair is reserved',
      text: 'Pay before the timer runs out, or the pair goes to the next person.',
      button: { action: 'pay', label: 'Pay now' },
    };
  }
  if (s.paid >= s.maxPerUser) {
    return {
      title: "You're all set",
      text: `You've bought ${s.paid} pairs, the maximum per person.`,
      button: { action: null, label: 'Limit reached' },
    };
  }
  if (s.position) {
    return {
      title: `You're #${s.position} in line`,
      text: "If a reserved pair isn't paid for in time, it's reserved for the next person in line automatically. Keep this page open.",
      button: { action: null, label: "You're in line" },
    };
  }
  if (s.available && s.paid) {
    return {
      title: 'Want another pair?',
      button: { action: 'buy', label: 'Buy another pair' },
    };
  }
  if (s.available) {
    return {
      title: 'Get your pair',
      text: 'Buying reserves a pair for you for 5 minutes while you pay.',
      button: { action: 'buy', label: 'Buy now' },
    };
  }
  return {
    title: 'Sold out',
    text: "Join the waiting line. If someone doesn't pay in time, their pair goes to the next person in line.",
    button: { action: 'waitlist', label: 'Join waiting line' },
  };
}
