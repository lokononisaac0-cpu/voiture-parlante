/**
 * VISION — Worker de recherche rapide
 *
 * Se déploie entièrement depuis le tableau de bord Cloudflare :
 *   1. Workers & Pages  >  Create  >  Start with Hello World  >  Deploy
 *   2. Edit code  >  colle tout ce fichier  >  Deploy
 *   3. Settings  >  Bindings  >  Add  >  Workers AI
 *         Variable name : AI
 *   4. Copie l'adresse du Worker et donne-la-moi
 *
 * Répond toujours : { "texte": "...", "reference": "..." }
 */

// Change de modèle ici si tu veux en essayer un autre.
// La liste à jour est dans le tableau de bord, onglet AI > Models.
const MODELE = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

function repondre(objet, statut) {
  return new Response(JSON.stringify(objet), {
    status: statut || 200,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS }
  });
}

// Le modèle imbrique parfois sa réponse : on descend jusqu'au texte réel
// plutôt que de convertir un objet en "[object Object]".
function chaineDe(v, profondeur) {
  profondeur = profondeur || 0;
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);
  if (profondeur > 6 || !v || typeof v !== "object") return "";

  if (Array.isArray(v)) {
    for (const x of v) {
      const t = chaineDe(x, profondeur + 1);
      if (t) return t;
    }
    return "";
  }
  for (const cle of ["texte", "text", "content", "value", "response",
                     "reponse", "result", "answer", "output", "message"]) {
    if (v[cle] !== undefined) {
      const t = chaineDe(v[cle], profondeur + 1);
      if (t) return t;
    }
  }
  for (const cle of Object.keys(v)) {
    const t = chaineDe(v[cle], profondeur + 1);
    if (t) return t;
  }
  return "";
}

const CONSIGNE = `Tu assistes une régie vidéo francophone : culte, formation,
conférence, séminaire. Le texte que tu produis sera projeté sur grand écran
devant un public.

Réponds UNIQUEMENT par un objet JSON valide, sans aucun texte autour,
sans salutation, sans balises de code, au format exact :
{"texte":"...","reference":"..."}

- Référence biblique (Jean 3:16, Psaume 23) : le verset complet en français
  dans "texte", la référence normalisée dans "reference".
- Question de connaissance (chiffre, définition, date, notion) : la réponse
  la plus courte et la plus claire possible dans "texte", et dans "reference"
  la source ou l'année si tu la connais. Si tu n'es pas sûr, dis-le franchement
  dans "texte" plutôt que d'inventer un chiffre.
- Idée à rédiger : une phrase courte, frappante, lisible de loin.

Règles de forme : pas plus de 300 caractères dans "texte", pas de listes à
puces, pas de mise en forme markdown. Jamais de commentaire ni d'explication
autour du JSON.`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    /* ------------------------------------------------------------------
       /turn — fabrique des identifiants TURN temporaires.
       Le jeton d'API reste ici, jamais dans la page.
       Réglages à ajouter : Settings > Variables and Secrets
         TURN_KEY_ID  (le Key ID affiché dans Realtime > TURN)
         TURN_TOKEN   (le jeton, affiché une seule fois)
       ------------------------------------------------------------------ */
    if (url.pathname === "/turn") {
      if (!env.TURN_KEY_ID || !env.TURN_TOKEN) {
        return repondre({ iceServers: [], info: "Relais non configuré." });
      }
      try {
        const base = "https://rtc.live.cloudflare.com/v1/turn/keys/" + env.TURN_KEY_ID;
        const entetes = {
          "Authorization": "Bearer " + env.TURN_TOKEN,
          "Content-Type": "application/json"
        };
        const corps = JSON.stringify({ ttl: 86400 });   // 24 h, largement assez

        // Cloudflare a deux points d'entrée selon les versions : on tente
        // le plus récent, puis l'ancien.
        let r = await fetch(base + "/credentials/generate-ice-servers",
                            { method: "POST", headers: entetes, body: corps });
        if (!r.ok) {
          r = await fetch(base + "/credentials/generate",
                          { method: "POST", headers: entetes, body: corps });
        }
        if (!r.ok) {
          return repondre({ iceServers: [], info: "Cloudflare a répondu " + r.status }, 200);
        }

        const j = await r.json();
        // La réponse est tantôt un tableau, tantôt un objet unique
        let serveurs = j.iceServers || j.ice_servers || [];
        if (!Array.isArray(serveurs)) serveurs = [serveurs];
        return repondre({ iceServers: serveurs });

      } catch (e) {
        return repondre({ iceServers: [], info: String(e.message || e) }, 200);
      }
    }

    if (request.method !== "POST") {
      return repondre({ texte: "", reference: "", erreur: "Utilise POST." }, 405);
    }

    let demande = "";
    try {
      const corps = await request.json();
      // On accepte les trois noms de champ envoyés par VISION
      demande = corps.prompt || corps.message || corps.question || "";
    } catch (_) {
      return repondre({ texte: "", reference: "", erreur: "JSON invalide." }, 400);
    }

    if (!demande.trim()) {
      return repondre({ texte: "", reference: "", erreur: "Demande vide." }, 400);
    }

    try {
      const ia = await env.AI.run(MODELE, {
        messages: [
          { role: "system", content: CONSIGNE },
          { role: "user", content: demande }
        ],
        max_tokens: 500,
        temperature: 0.2        // basse : on veut du littéral, pas de l'inventif
      });

      // Surtout pas de .toString() ici : sur un objet il produirait
      // littéralement "[object Object]" et le texte serait perdu.
      const brut = chaineDe(ia.response) || chaineDe(ia.result) || chaineDe(ia);

      // Le modèle glisse parfois du texte autour : on isole l'objet JSON
      const bloc = brut.replace(/```json|```/g, "").trim();
      const trouve = bloc.match(/\{[\s\S]*\}/);

      if (trouve) {
        try {
          const o = JSON.parse(trouve[0]);
          const texte = chaineDe(o.texte || o.text);
          if (texte) {
            return repondre({
              texte,
              reference: chaineDe(o.reference || o.ref)
            });
          }
        } catch (_) { /* on retombe sur le texte brut */ }
      }

      return repondre({ texte: bloc, reference: "" });

    } catch (e) {
      return repondre({ texte: "", reference: "", erreur: String(e.message || e) }, 500);
    }
  }
};
