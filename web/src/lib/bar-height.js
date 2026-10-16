// The demo's bar wraps on a phone: its real height, read before the first paint, is what the cover and the panel leave it.
{
  const bar = document.querySelector('.demo-bar');
  const measure = () => document.documentElement.style.setProperty('--bar-h', `${bar.offsetHeight}px`);
  measure();
  new ResizeObserver(measure).observe(bar);
}
