import { ReservationManager } from './reservation-manager.js';

export class ReservationReaper {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private reservationManager: ReservationManager,
    private intervalMs: number = 60 * 1000 // default run every 60 seconds
  ) {}

  start(): void {
    if (this.timer) return;

    this.timer = setInterval(() => {
      this.runOnce();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  runOnce(): number {
    return this.reservationManager.expireStaleReservations();
  }
}
