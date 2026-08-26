// toast.js — Minimal toast notification system
(function() {
  // showToast(message, type, duration, customIconName)
  // customIconName: optional icon name (e.g. 'star', 'starOutline') to override the type-based icon
  function showToast(message, type, duration, customIconName) {
    type = type || 'info';
    if (duration === undefined) duration = 4000;

    var container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      document.body.appendChild(container);
    }

    var icons = { success: 'check', error: 'cross', warning: 'warning', info: 'info' };
    var iconName = customIconName || icons[type] || icons.info;
    var toast = document.createElement('div');
    toast.className = 'toast toast-' + type;
    toast.innerHTML = '<span class="toast-icon">' + (window.icon(iconName, { size: 16 }) || iconName) + '</span><span class="toast-msg"></span><button class="toast-close" onclick="this.parentElement.remove()" aria-label="Fermer">×</button>';
    // Use textContent for the message — safely escapes any HTML, prevents raw SVG/code injection
    toast.querySelector('.toast-msg').textContent = message;
    toast.setAttribute('role', 'alert');
    toast.setAttribute('aria-live', 'assertive');
    container.appendChild(toast);

    // Trigger animation
    requestAnimationFrame(function() { toast.classList.add('show'); });

    if (duration > 0) {
      setTimeout(function() {
        toast.classList.remove('show');
        setTimeout(function() { toast.remove(); }, 300);
      }, duration);
    }
  }

  window.showToast = showToast;
})();
