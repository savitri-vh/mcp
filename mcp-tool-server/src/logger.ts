export type LogLevel = "debug" | "info" | "warn" | "error";

export class Logger {
  constructor(private readonly level: LogLevel = "info") {}

  private shouldLog(level: LogLevel): boolean {
    const order: LogLevel[] = ["debug", "info", "warn", "error"];
    return order.indexOf(level) >= order.indexOf(this.level);
  }

  private write(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (!this.shouldLog(level)) {
      return;
    }

    const payload = {
      time: new Date().toISOString(),
      level,
      message,
      ...(meta && Object.keys(meta).length ? { meta } : {})
    };

    // eslint-disable-next-line no-console
    console.log(JSON.stringify(payload));
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.write("debug", message, meta);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.write("info", message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.write("warn", message, meta);
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.write("error", message, meta);
  }
}
