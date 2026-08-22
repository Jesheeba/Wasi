# Wasi CRM — production image, deployed behind the VPS's own nginx + certbot.
#
# Build context is the REPO ROOT, not server/. server/src/app.js serves the
# static frontend (index.html, app.js, marketing/, admin/) from two levels
# above server/src (REPO_ROOT = path.join(__dirname, '..', '..') in app.js),
# so both server/ and the root-level static files have to land in the image
# at the same relative layout they have in the repo.
#
# flow-editor-build is the one exception to this app's no-build-step
# convention (Stage 1 of the flow-builder rebuild — React + @xyflow/react,
# see flow-editor/package.json's comment) — a genuinely separate build
# stage, not folded into the main stage below, specifically so the final
# image never carries React/Vite/the flow-editor's node_modules, only the
# static dist/ output it produces. The main app (index.html/app.js/
# index.css) and server/ are completely untouched by this stage — it reads
# only flow-editor/ and writes only flow-editor/dist, copied into the final
# image the same way index.html/index.css/app.js already are, served from
# its own path (server/src/app.js's /flow-editor static mount) rather than
# being injected into the existing pages' load path.
FROM node:20-alpine AS flow-editor-build
WORKDIR /build
COPY flow-editor/package.json flow-editor/package-lock.json* ./
RUN npm install
COPY flow-editor/ ./
RUN npm run build

FROM node:20-alpine

WORKDIR /app

# Install deps first, separately from app code, so `docker compose build`
# doesn't reinstall node_modules on every source change — only when
# package.json/package-lock.json actually change.
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev

# App code.
COPY server ./server
COPY index.html index.css app.js embeddedSignup.js ./
COPY marketing ./marketing
COPY admin ./admin
COPY --from=flow-editor-build /build/dist ./flow-editor/dist

WORKDIR /app/server

ENV NODE_ENV=production
EXPOSE 4002

# No curl/wget in alpine by default — use Node's built-in fetch instead of
# adding a package just for this. Reads PORT from the container's own env
# (falls back to the app's own default) rather than hardcoding a port
# number, since this image is run with whichever PORT the VPS's port map
# assigns it (currently 4002 — see docker-compose.yml).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
