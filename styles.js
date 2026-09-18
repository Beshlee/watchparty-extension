// styles.js — panel Shadow DOM içinde render edildiği için stiller buradan
// JS string olarak enjekte edilir (harici bir .css dosyası shadow DOM'un
// içine otomatik uygulanmaz).
const WATCHPARTY_CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }

  .wp-bubble {
    width: 48px; height: 48px; border-radius: 50%;
    background: #6d28d9; color: #fff; border: none;
    font-size: 22px; cursor: pointer;
    box-shadow: 0 2px 10px rgba(0,0,0,0.35);
  }
  .wp-bubble:hover { background: #7c3aed; }

  .wp-panel {
    position: absolute;
    bottom: 58px; right: 0;
    width: 300px;
    background: #1e1b2e;
    color: #f1f0f5;
    border-radius: 12px;
    box-shadow: 0 8px 30px rgba(0,0,0,0.45);
    padding: 12px;
    font-size: 13px;
  }
  .wp-panel.wp-hidden { display: none; }

  .wp-header {
    display: flex; justify-content: space-between; align-items: center;
    font-weight: 600; margin-bottom: 6px; font-size: 14px;
  }
  .wp-close {
    background: none; border: none; color: #cfc9e6; cursor: pointer; font-size: 14px;
  }

  .wp-status { color: #b7aee0; margin-bottom: 8px; min-height: 16px; }

  .wp-section label {
    display: block; margin: 6px 0 2px; color: #cfc9e6; font-size: 12px;
  }
  .wp-section input[type="text"] {
    width: 100%; padding: 6px 8px; border-radius: 6px;
    border: 1px solid #3a3452; background: #2a2540; color: #fff;
    margin-bottom: 4px;
  }

  .wp-row { display: flex; gap: 6px; margin-top: 6px; }

  .wp-btn {
    flex: 1; padding: 7px 8px; border-radius: 6px; border: 1px solid #3a3452;
    background: #2a2540; color: #fff; cursor: pointer; font-size: 12px;
  }
  .wp-btn:hover { background: #352e52; }
  .wp-btn-primary { background: #6d28d9; border-color: #6d28d9; }
  .wp-btn-primary:hover { background: #7c3aed; }
  .wp-leave { margin-top: 8px; width: 100%; background: #4a1d2a; border-color: #6b2438; }
  .wp-leave:hover { background: #5c2434; }

  .wp-hidden { display: none; }

  .wp-room-info { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; flex-wrap: wrap; }
  .wp-copy { font-size: 11px; padding: 2px 6px; border-radius: 4px; border: 1px solid #3a3452; background: #2a2540; color: #fff; cursor: pointer; }
  .wp-count { color: #9d94c0; margin-left: auto; font-size: 12px; }

  .wp-chat {
    height: 140px; overflow-y: auto; background: #16132399;
    border: 1px solid #3a3452; border-radius: 6px; padding: 6px; margin-bottom: 6px;
  }
  .wp-chat-line { margin-bottom: 4px; word-wrap: break-word; line-height: 1.35; }
  .wp-chat-name { font-weight: 600; color: #b39ddb; }
  .wp-mine .wp-chat-name { color: #7ee787; }
`;
