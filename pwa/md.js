// Pi Mobile — tiny, dependency-free Markdown renderer for transcript text.
// Safety model: ALL source text is HTML-escaped first; the renderer only ever emits
// its own fixed tags around escaped text, and links are limited to http(s)/mailto.
// Supports: fenced code (with language label + copy), inline code, headings, bold,
// italic, strikethrough, links/autolinks, ordered/unordered/task lists (nested),
// blockquotes, horizontal rules, and GFM tables.
"use strict";

(function () {
  const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  const RE = {
    fence: /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/,
    heading: /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/,
    hr: /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/,
    quote: /^ {0,3}>\s?/,
    list: /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/,
    tableSep: /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/,
    blank: /^\s*$/,
  };
  const indentOf = (line) => line.match(/^\s*/)[0].replace(/\t/g, "    ").length;

  // ---------- inline ----------
  function inline(src) {
    const slots = [];
    const hold = (html) => "\u0000" + (slots.push(html) - 1) + "\u0000";
    let s = escHtml(src);
    // code spans first, so nothing inside them is formatted
    s = s.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, _t, code) => hold(`<code>${code.trim() === "" ? code : code.replace(/^ (.*) $/, "$1")}</code>`));
    // [text](url)
    s = s.replace(/\[([^\]]+)\]\(\s*([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\s*\)/g, (m, text, url) => {
      if (!/^(https?:\/\/|mailto:)/i.test(url)) return text;
      return hold(`<a href="${url}" target="_blank" rel="noopener noreferrer">${fmt(text)}</a>`);
    });
    // bare URLs (the text is already escaped, so stop at &quot; / &lt; / &gt; entities)
    s = s.replace(/\bhttps?:\/\/(?:(?!&quot;|&lt;|&gt;)[^\s<])+/g, (url) => {
      const trail = url.match(/[.,:;!?)\]']+$/);
      const u = trail ? url.slice(0, -trail[0].length) : url;
      return hold(`<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`) + (trail ? trail[0] : "");
    });
    s = fmt(s);
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[+i]);
  }
  function fmt(s) {
    return s
      .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, "$1<strong>$2</strong>")
      .replace(/(^|[^*\w])\*(?=[^\s*])([^*]*?[^\s*])\*(?!\*)/g, "$1<em>$2</em>")
      .replace(/(^|[^\w])_(?=[^\s_])([^_]*?[^\s_])_(?!\w)/g, "$1<em>$2</em>")
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>");
  }

  // ---------- blocks ----------
  function blocks(lines) {
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (RE.blank.test(line)) { i++; continue; }

      // fenced code
      let m = line.match(RE.fence);
      if (m) {
        const fence = m[1], lang = m[2] || "";
        const body = [];
        i++;
        while (i < lines.length && !new RegExp("^ {0,3}" + fence[0] + "{" + fence.length + ",}\\s*$").test(lines[i])) body.push(lines[i++]);
        i++; // closing fence (or EOF)
        out.push(codeBlock(body.join("\n"), lang));
        continue;
      }

      if ((m = line.match(RE.heading))) {
        const n = m[1].length;
        out.push(`<h${n}>${inline(m[2])}</h${n}>`);
        i++; continue;
      }

      if (RE.hr.test(line)) { out.push("<hr>"); i++; continue; }

      if (RE.quote.test(line)) {
        const body = [];
        while (i < lines.length && !RE.blank.test(lines[i]) && (RE.quote.test(lines[i]) || body.length)) {
          if (!RE.quote.test(lines[i]) && startsBlock(lines[i])) break;
          body.push(lines[i].replace(RE.quote, "")); i++;
        }
        out.push(`<blockquote>${blocks(body)}</blockquote>`);
        continue;
      }

      if (line.includes("|") && i + 1 < lines.length && RE.tableSep.test(lines[i + 1]) && lines[i + 1].includes("-")) {
        const head = cells(line);
        const aligns = cells(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? "center" : /-:$/.test(c) ? "right" : /^:-/.test(c) ? "left" : ""));
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes("|") && !RE.blank.test(lines[i])) rows.push(cells(lines[i++]));
        const td = (tag, c, k) => `<${tag}${aligns[k] ? ` style="text-align:${aligns[k]}"` : ""}>${inline(c)}</${tag}>`;
        out.push(
          `<div class="md-table"><table><thead><tr>${head.map((c, k) => td("th", c, k)).join("")}</tr></thead>` +
          `<tbody>${rows.map((r) => `<tr>${head.map((_, k) => td("td", r[k] || "", k)).join("")}</tr>`).join("")}</tbody></table></div>`
        );
        continue;
      }

      if (RE.list.test(line)) { i = list(lines, i, out); continue; }

      // paragraph: consecutive lines until a blank line or another block starts
      const para = [line.trim()];
      i++;
      while (i < lines.length && !RE.blank.test(lines[i]) && !startsBlock(lines[i])) para.push(lines[i++].trim());
      out.push(`<p>${para.map(inline).join("<br>")}</p>`);
    }
    return out.join("");
  }

  function startsBlock(line) {
    return RE.fence.test(line) || RE.heading.test(line) || RE.hr.test(line) || RE.quote.test(line) || RE.list.test(line);
  }

  function cells(row) {
    let r = row.trim();
    if (r.startsWith("|")) r = r.slice(1);
    if (r.endsWith("|") && !r.endsWith("\\|")) r = r.slice(0, -1);
    return r.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
  }

  function list(lines, i, out) {
    const first = lines[i].match(RE.list);
    const base = indentOf(first[1]);
    const ordered = /\d/.test(first[2]);
    const start = ordered ? parseInt(first[2], 10) : 1;
    const items = [];
    let loose = false;
    while (i < lines.length) {
      const m = lines[i].match(RE.list);
      if (!m || indentOf(m[1]) !== base || /\d/.test(m[2]) !== ordered) break;
      const contentIndent = base + m[2].length + 1;
      const body = [m[3]];
      i++;
      while (i < lines.length) {
        const l = lines[i];
        if (RE.blank.test(l)) {
          // a blank line continues the item only if the next line is indented into it
          const next = lines[i + 1];
          if (next !== undefined && !RE.blank.test(next) && indentOf(next) > base) { body.push(""); loose = true; i++; continue; }
          break;
        }
        const ind = indentOf(l);
        if (ind > base) { body.push(" ".repeat(Math.max(0, ind - contentIndent)) + l.trim()); i++; continue; }
        if (RE.list.test(l) || startsBlock(l)) break;
        body.push(l.trim()); i++; // lazy continuation
      }
      items.push(body);
    }
    const lis = items.map((body) => {
      let html = blocks(body);
      if (!loose) html = html.replace(/^<p>([\s\S]*?)<\/p>/, "$1"); // tight list: no <p> padding
      const task = html.match(/^\[( |x|X)\]\s+/);
      if (task) {
        const done = task[1] !== " ";
        return `<li class="task"><span class="tick${done ? " done" : ""}">${done ? "✓" : ""}</span><span>${html.slice(task[0].length)}</span></li>`;
      }
      return `<li>${html}</li>`;
    }).join("");
    out.push(ordered ? `<ol${start !== 1 ? ` start="${start}"` : ""}>${lis}</ol>` : `<ul>${lis}</ul>`);
    return i;
  }

  function codeBlock(code, lang) {
    const label = lang ? escHtml(lang) : "code";
    return `<div class="md-code"><div class="md-code-head"><span>${label}</span>` +
      `<button type="button" class="md-copy" aria-label="Copy code">Copy</button></div>` +
      `<pre><code>${escHtml(code)}</code></pre></div>`;
  }

  window.renderMarkdown = function (src) {
    return blocks(String(src == null ? "" : src).replace(/\r\n?/g, "\n").split("\n"));
  };
})();
