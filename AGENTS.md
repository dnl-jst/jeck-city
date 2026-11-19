# Hinweise für Agenten

## Release

Die Version des Spiels steht an genau einer Stelle: `version` in der `package.json` im Wurzelverzeichnis. Client
(Anzeige unten links, `apps/client/vite.config.ts` → `__NN_VERSION__`) und Server (`apps/server/src/version.ts`,
`welcome` und `/healthz`) lesen sie von dort.

**Bei jedem Release muss diese Version geändert werden** – vor dem Tag, im selben Stand, der getaggt wird:

1. `npm version <neue Version> --no-git-tag-version` im Wurzelverzeichnis (ändert `package.json` und
   `package-lock.json`), committen und über einen PR nach `main` bringen.
2. Erst danach den Tag `v<neue Version>` auf diesen Stand setzen. Tag und `package.json` müssen dieselbe Version
   tragen – der Tag `v*` löst den Bau des Docker-Images aus (`.github/workflows/docker-image.yml`), und das Spiel zeigt
   die Version aus der `package.json` an.

Die `version`-Felder der Workspace-Pakete (`apps/*`, `packages/*`) werden nirgends angezeigt und bleiben unberührt.
