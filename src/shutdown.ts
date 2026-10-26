export function handleShutdown(close: () => Promise<void>): void {
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void close().then(() => process.exit(0)).catch(() => process.exit(1));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
