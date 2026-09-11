# Buyer Radar.
#
# One image runs both services: the dashboard (the default command) and the
# scheduler (node src/cron.mjs). Everything else is Node built-ins.
FROM node:20-alpine

# tini gives the container a real init, so SIGTERM reaches Node and the
# scheduler shuts down cleanly instead of being killed after the grace period.
RUN apk add --no-cache tini

WORKDIR /app

# `pg` is the only dependency and it is loaded lazily. Installing it here means
# the Postgres store works in the container; with no DATABASE_URL the JSON store
# under /app/data is used and nothing in node_modules is ever loaded.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY config ./config
COPY src ./src
COPY tools ./tools
COPY docs ./docs
COPY README.md ./

# The generated directories. Mount volumes over these to keep the data.
RUN mkdir -p data runs digests exports reports outbox \
 && chown -R node:node /app

USER node

ENV NODE_ENV=production \
    RADAR_PORT=4710
EXPOSE 4710

# A container with no token must fail loudly at start, not serve an open page.
HEALTHCHECK --interval=60s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const t=process.env.RADAR_OWNER_TOKEN;if(!t)process.exit(1);require('http').get({host:'127.0.0.1',port:process.env.RADAR_PORT||4710,path:'/',headers:{Authorization:'Bearer '+t}},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node","src/dashboard/server.mjs"]
