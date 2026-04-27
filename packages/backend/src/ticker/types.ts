export interface TickerTask {
  id: string;
  fireAt: number;
  callback: () => void;
  repeat?: number;
}

export interface Ticker {
  schedule(task: TickerTask): void;
  cancel(id: string): void;
  reschedule(id: string, newFireAt: number): void;
  destroy(): void;
  size(): number;
}
