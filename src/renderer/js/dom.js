/** Minimal DOM helpers. No framework, no build step. */

/**
 * Create an element.
 *
 * @param {string} tag
 * @param {object} [props] `class`, `text`, `html`, `dataset`, `style` and any
 *                         other property assigned directly onto the element;
 *                         `on` holds event listeners.
 * @param {Array<Node|string|null|false>} [children]
 */
export function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);

    for (const [key, value] of Object.entries(props)) {
        if (value === null || value === undefined || value === false) continue;

        if (key === "class") node.className = value;
        else if (key === "text") node.textContent = value;
        else if (key === "dataset") Object.assign(node.dataset, value);
        // Custom properties have to go through setProperty; assigning them as
        // plain style keys silently does nothing.
        else if (key === "style") {
            for (const [prop, val] of Object.entries(value)) {
                if (prop.startsWith("--")) node.style.setProperty(prop, val);
                else node.style[prop] = val;
            }
        }
        else if (key === "on") for (const [type, fn] of Object.entries(value)) node.addEventListener(type, fn);
        else if (key in node) node[key] = value;
        else node.setAttribute(key, value);
    }

    for (const child of children.flat()) {
        if (child === null || child === undefined || child === false) continue;
        node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
}

export function clear(node) {
    node.replaceChildren();
    return node;
}

export const $ = (selector, root = document) => root.querySelector(selector);

/** Coalesce rapid calls into one, on the next animation frame. */
export function raf(fn) {
    let queued = false;
    return (...args) => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => {
            queued = false;
            fn(...args);
        });
    };
}

/** Debounce, for text inputs that trigger a round trip to the main process. */
export function debounce(fn, ms = 120) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), ms);
    };
}

export function pluralize(n, singular, plural = `${singular}s`) {
    return `${n} ${n === 1 ? singular : plural}`;
}
