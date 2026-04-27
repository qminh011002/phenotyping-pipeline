# syntax=docker/dockerfile:1.7

# ─── Stage 1: build the static bundle ────────────────────────────────────────
FROM node:lts-alpine AS build

WORKDIR /app

# Build args. These become env vars only during this build stage.
# Vite STRING-REPLACES these into the JS bundle at `npm run build` time.
# They are public — anything here is shipped to the user's browser.
ARG VITE_API_BASE_URL=/api
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL

# Layer-cache deps separately from source. Changing src/ does not rebuild
# this layer because we copy metadata first. The BuildKit cache mount also
# preserves npm's download cache across layer invalidations (when the lockfile
# DOES change, only changed packages are re-downloaded, not all of them).
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci

# Now copy the rest and build.
COPY . .
RUN npm run build

# ─── Stage 2: serve via nginx ────────────────────────────────────────────────
FROM nginx:1.30-alpine

# Replace the default site config with ours (SPA fallback + caching).
RUN rm /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy only the built static bundle from the previous stage.
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -q --spider http://localhost/ || exit 1
