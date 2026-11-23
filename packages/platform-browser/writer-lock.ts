/** The app SQL projections and local command host have one owner per browser profile. */
export async function acquireWriter() {
  if (!navigator.locks)
    throw Error(
      "This browser needs Web Locks support to open its local services.",
    );
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ownership!: Promise<unknown>;
  await new Promise<void>((resolve, reject) => {
    ownership = navigator.locks
      .request(
        "jocki-device-writer",
        { ifAvailable: true },
        async (lock) => {
          if (!lock) {
            reject(
              Error(
                "Jocki is already open in another tab. Close that tab before opening this workspace.",
              ),
            );
            return;
          }
          resolve();
          await held;
        },
      )
      .catch(reject);
  });
  return async () => {
    release();
    await ownership;
  };
}
