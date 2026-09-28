import { CanDeactivateFn } from '@angular/router';

/** A routed component that must settle its own state before the route changes. */
export interface LeaveGuarded {
  canLeave(): boolean | Promise<boolean>;
}

export const canLeave: CanDeactivateFn<LeaveGuarded> = (component) => component.canLeave();
