'use strict';

let installed = false;

function install() {
  if (installed) return;
  installed = true;

  const desc = Object.getOwnPropertyDescriptor(process, 'title');
  if (desc && desc.configurable === false) return;

  let title;
  try { title = String(process.title || 'node'); }
  catch { title = 'node'; }

  try {
    Object.defineProperty(process, 'title', {
      configurable: true,
      enumerable: desc ? desc.enumerable : true,
      get() { return title; },
      set(value) {
        title = String(value || '');
      },
    });
  } catch {}
}

module.exports = { install };
