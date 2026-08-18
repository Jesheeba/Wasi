# Wasi CRM — production image, deployed behind the VPS's own nginx + certbot.
#
# Build context is the REPO ROOT, not server/. server/src/app.js serves the
# static frontend (index.html, app.js, marketing/, admin/) from two levels
# above server/src (REPO_ROOT = path.join(__dirname, '..', '..') in app.js),
# so both server/ and the root-level static files have to land in the image
# at the same relative layout they have in the repo.
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
