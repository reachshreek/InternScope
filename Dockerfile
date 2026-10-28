FROM node:24-bookworm-slim
WORKDIR /app
COPY requirements-jobspy.txt ./
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/jobspy && /opt/jobspy/bin/pip install --no-cache-dir -r requirements-jobspy.txt
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY public ./public
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/app/data JOBSPY_PYTHON=/opt/jobspy/bin/python
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3000
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
