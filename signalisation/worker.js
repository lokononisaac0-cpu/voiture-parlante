/**
 * VISION — Serveur de signalisation
 *
 * Remplace le serveur public PeerJS par le tien. Il parle exactement le
 * même protocole, donc rien ne change dans l'application : on lui indique
 * seulement une autre adresse.
 *
 * Ce serveur ne voit JAMAIS la vidéo. Il transporte uniquement les quelques
 * messages qui permettent à deux appareils de se trouver, puis il s'efface.
 *
 * Déploiement : Cloudflare > Workers & Pages > Create > Import a repository
 * (voir le fichier LISEZ-MOI.md à côté).
 */

const OUVERT   = JSON.stringify({ type: "OPEN" });
const PRIS     = JSON.stringify({ type: "ID-TAKEN", payload: { msg: "ID is taken" } });
const BATTEMENT = JSON.stringify({ type: "HEARTBEAT" });

export class Registre {
  constructor(state) {
    this.state = state;

    // Les battements de cœur sont renvoyés sans réveiller l'objet :
    // des centaines de connexions ouvertes ne coûtent presque rien.
    this.state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(BATTEMENT, BATTEMENT)
    );
  }

  async fetch(request) {
    const url = new URL(request.url);

    // PeerJS demande un identifiant quand le client n'en fournit pas
    if (url.pathname.endsWith("/id")) {
      return new Response(crypto.randomUUID().replace(/-/g, ""), {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("VISION — signalisation active", {
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
    }

    const id    = url.searchParams.get("id");
    const jeton = url.searchParams.get("token") || "";
    if (!id) return new Response("id manquant", { status: 400 });

    const { 0: client, 1: serveur } = new WebSocketPair();

    // Identifiant déjà utilisé par quelqu'un d'autre : on refuse.
    // C'est ce qui fait qu'une régie change de code toute seule.
    const existant = this.trouver(id);
    if (existant) {
      const a = existant.deserializeAttachment();
      if (a && a.jeton !== jeton) {
        this.state.acceptWebSocket(serveur);
        try { serveur.send(PRIS); serveur.close(1000, "id-taken"); } catch (_) {}
        return new Response(null, { status: 101, webSocket: client });
      }
      // Même jeton : c'est une reconnexion, on ferme l'ancienne
      try { existant.close(1000, "remplace"); } catch (_) {}
    }

    this.state.acceptWebSocket(serveur);
    serveur.serializeAttachment({ id, jeton });
    try { serveur.send(OUVERT); } catch (_) {}

    return new Response(null, { status: 101, webSocket: client });
  }

  /* ---------- Acheminement des messages ---------- */

  async webSocketMessage(ws, brut) {
    let msg;
    try { msg = JSON.parse(brut); } catch (_) { return; }
    if (!msg || msg.type === "HEARTBEAT") return;

    const moi = ws.deserializeAttachment();
    if (!moi) return;

    msg.src = moi.id;            // impossible d'usurper l'expéditeur
    const dst = msg.dst;
    if (!dst) return;

    const cible = this.trouver(dst);
    if (cible) {
      try { cible.send(JSON.stringify(msg)); } catch (_) {}
    } else {
      // Destinataire absent : PeerJS attend ce message précis pour
      // déclencher son erreur "peer-unavailable" côté client.
      try {
        ws.send(JSON.stringify({
          type: "EXPIRE", src: dst, dst: moi.id, payload: {}
        }));
      } catch (_) {}
    }
  }

  async webSocketClose(ws)  { this.partir(ws); }
  async webSocketError(ws)  { this.partir(ws); }

  partir(ws) {
    // Rien à nettoyer : la socket disparaît d'elle-même de getWebSockets()
  }

  trouver(id) {
    for (const ws of this.state.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (a && a.id === id) return ws;
    }
    return null;
  }
}

/* ---------- Point d'entrée ---------- */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/" && request.headers.get("Upgrade") !== "websocket") {
      return new Response("VISION — signalisation active", {
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
    }

    // Un seul registre partagé : tous les appareils doivent pouvoir
    // se trouver entre eux, quel que soit leur code de salle.
    const id = env.REGISTRE.idFromName("global");
    return env.REGISTRE.get(id).fetch(request);
  }
};
