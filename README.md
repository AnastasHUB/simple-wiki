# 🧭 Simple Wiki

![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express.js-🛣️-000000)
![License](https://img.shields.io/badge/License-MIT-blue.svg)
![PRs Welcome](https://img.shields.io/badge/PRs-Welcome-brightgreen.svg)

Simple Wiki est une application Express/EJS qui permet de créer un wiki privé avec un workflow de modération et une intégration webhook prête à l'emploi.

## 🚀 Démarrage rapide

```bash
npm install
npm run db:init
npm start
```

> 🔐 Le compte administrateur par défaut est `admin` / `admin`. Il est créé avec un mot de passe haché lors de `npm run db:init`. Pensez à le modifier dès la première connexion !

## 🛠️ Scripts utiles

| Script | Description |
| --- | --- |
| `npm start` | Lance le serveur Express en mode production. |
| `npm run dev` | Démarre le serveur avec rechargement automatique (`node --watch`). |
| `npm run db:init` | Initialise la base SQLite, crée les tables et ajoute l’administrateur par défaut. |
| `npm run views:aggregate` | Agrège les statistiques de vues journalières. |

## ⚙️ Configuration

L’application lit la configuration des sessions à partir de variables d’environnement afin de conserver les secrets en dehors du dépôt :

- `SESSION_SECRET` ou `SESSION_SECRETS` : une ou plusieurs valeurs (séparées par des virgules) utilisées pour signer les cookies de session. Plusieurs secrets permettent d’effectuer une rotation en douceur.
- `SESSION_SECRET_FILE` : chemin optionnel vers un fichier contenant un secret par ligne. Le fichier est surveillé afin qu’un nouveau secret soit pris en compte sans redémarrer le serveur.
- `SESSION_COOKIE_*` : paramètres supplémentaires pour le cookie (`NAME`, `SECURE`, `HTTP_ONLY`, `SAMESITE`, `MAX_AGE`, `ROLLING`).

Sans secret explicite, l’application génère une valeur temporaire adaptée uniquement au développement et affiche un avertissement. Configurez toujours un secret robuste pour la production.

Les mots de passe créés avant la migration vers bcrypt sont automatiquement ré-hachés lors de la prochaine connexion réussie. Informez vos utilisateurs qu’une reconnexion peut être nécessaire ou réinitialisez leur mot de passe depuis le panneau d’administration.

## 🧩 Fonctionnalités principales

- ✏️ Édition collaborative des pages avec historique des révisions.
- 💬 Modération des commentaires avec tokens d’édition temporaires.
- 🔍 Recherche plein texte grâce à SQLite FTS (si disponible).
- 📊 Statistiques de vues et likes par page.
- 📡 Webhooks Discord pour les flux « admin » et « feed » avec validation des URL, retries automatiques et options de personnalisation (contenu, auteur, composants, pièces jointes).

## 📚 Documentation

Une documentation statique décrivant la structure du projet et les bonnes pratiques est disponible dans `docs/index.html`. Servez-vous-en pour intégrer l’application dans votre infrastructure ou onboarding de nouveaux contributeurs.

Bon wiki ! 📝
