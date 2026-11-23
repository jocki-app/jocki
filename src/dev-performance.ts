// React's development performance tracks retain a measure for each render.
// Release those entries after delivery instead of accumulating cloned prop details.
// This does not catch render errors or change the browser's tracing API.
if (import.meta.env.DEV && typeof PerformanceObserver !== "undefined") {
  const observer = new PerformanceObserver((list) => {
    const names = new Set<string>();
    for (const entry of list.getEntries()) {
      const details = (entry as PerformanceMeasure).detail?.devtools;
      if (
        details?.track === "Components ⚛" ||
        details?.trackGroup === "Scheduler ⚛"
      )
        names.add(entry.name);
    }
    for (const name of names) performance.clearMeasures(name);
  });
  observer.observe({ type: "measure", buffered: true });
  import.meta.hot?.dispose(() => observer.disconnect());
}
