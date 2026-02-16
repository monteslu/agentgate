/**
 * Render a page template inside the main layout.
 * Usage: renderPage(res, 'pages/settings', { title: 'Settings', ...data })
 */
export function renderPage(res, page, data = {}) {
  const app = res.app;
  // First render the page content
  app.render(page, data, (err, content) => {
    if (err) {
      console.error('Template render error:', err);
      return res.status(500).send('Template render error');
    }
    // Then render the layout with the page content injected
    res.render('layouts/main', { ...data, content });
  });
}
