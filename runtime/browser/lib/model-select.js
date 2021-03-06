/**
 * @license
 * Copyright (c) 2017 Google Inc. All rights reserved.
 * This code may only be used under the BSD style license found at
 * http://polymer.github.io/LICENSE.txt
 * Code distributed by Google as part of this project is also
 * subject to an additional IP rights grant found at
 * http://polymer.github.io/PATENTS.txt
 */
'use strict';

class ModelSelect extends HTMLElement {
  connectedCallback() {
    this.style.display = 'inline-block';
    this._requireSelect();
  }
  _requireSelect() {
    return this.select = this.select || this.appendChild(document.createElement('select'));
  }
  set options(options) {
    let select = this._requireSelect();
    select.textContent = '';
    options && options.forEach(o =>
      select.appendChild(
        Object.assign(document.createElement("option"), {
          value: o.value || o,
          text: o.text || o.value || o
        })
      )
    );
  }
}

customElements.define('model-select', ModelSelect);

module.exports = ModelSelect;