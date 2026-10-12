// netlify/build-catalog.js — runs on every Netlify deploy.
// Reads the artists/releases built into index.html and writes
// netlify/functions/catalog.json: the ONLY prices the checkout will charge.
// Changing a price = edit it in Admin, Export, have it built into index.html,
// upload to GitHub. Nobody can change prices from their browser.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function readVar(name) {
  const m = html.match(new RegExp('^(?:let|var|const) ' + name + ' = (.*);\\s*(?://.*)?$', 'm'));
  if (!m) throw new Error('Could not find "' + name + '" in index.html');
  return JSON.parse(m[1]);
}

const artists = readVar('artists');
const releases = readVar('releases');
const artistName = {};
artists.forEach(function (a) { artistName[a.id] = a.name; });

const catalog = {
  builtAt: new Date().toISOString(),
  releases: releases.map(function (r) {
    return {
      id: r.id,
      title: r.title,
      artist: artistName[r.artistId] || '',
      type: r.type,
      price: Number(r.price) || 0,
      trackPrice: Number(r.trackPrice) || 0,
      tracks: (r.tracks || []).map(function (t) { return { id: String(t.id), title: t.title }; }),
      bundles: (r.bundles || []).map(function (b) {
        return { id: String(b.id), name: b.name, price: Number(b.price) || 0, hasMerch: true };
      }),
    };
  }),
};

fs.writeFileSync(path.join(__dirname, 'functions', 'catalog.json'), JSON.stringify(catalog, null, 2));
console.log('catalog.json: ' + catalog.releases.length + ' releases, ' +
  catalog.releases.reduce(function (n, r) { return n + r.tracks.length; }, 0) + ' tracks');
