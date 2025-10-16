export const PERMISSION_CATEGORIES = [
  {
    key: "core",
    label: "Accès rapides",
    description:
      "Contrôles généraux permettant d'accorder rapidement des ensembles de permissions cohérents.",
    groups: [
      {
        label: "Raccourcis de rôle",
        permissions: [
          {
            field: "is_admin",
            label: "Administrateur",
            description:
              "Donne un accès complet à toutes les fonctionnalités sans restriction.",
            isAggregate: true,
          },
          {
            field: "is_moderator",
            label: "Modérateur",
            description:
              "Autorise la modération générale des contenus et l'accès aux outils clés du staff.",
            isAggregate: true,
          },
          {
            field: "is_helper",
            label: "Aide à la modération",
            description:
              "Permet de publier des commentaires immédiatement et d'assister l'équipe de modération.",
            isAggregate: true,
          },
          {
            field: "is_contributor",
            label: "Contributeur",
            description:
              "Autorise la création et la publication directe de nouvelles pages.",
            isAggregate: true,
          },
        ],
      },
      {
        label: "Participation",
        permissions: [
          {
            field: "can_comment",
            label: "Commenter",
            description: "Permet de publier des commentaires sur les articles publics.",
          },
          {
            field: "can_submit_pages",
            label: "Soumettre des contenus",
            description: "Autorise l'envoi de brouillons de pages pour relecture.",
          },
        ],
      },
    ],
  },
  {
    key: "comments",
    label: "Commentaires",
    description: "Contrôle précis de la modération des commentaires.",
    groups: [
      {
        label: "Accès global",
        permissions: [
          {
            field: "can_moderate_comments",
            label: "Modération complète",
            description:
              "Accès intégral à la file et aux actions de modération des commentaires.",
            isAggregate: true,
          },
        ],
      },
      {
        label: "Actions détaillées",
        permissions: [
          {
            field: "can_view_comment_queue",
            label: "Voir la file d'attente",
            description: "Consulter les commentaires en attente de modération.",
          },
          {
            field: "can_approve_comments",
            label: "Approuver",
            description: "Valider un commentaire pour qu'il soit visible publiquement.",
          },
          {
            field: "can_reject_comments",
            label: "Rejeter",
            description: "Refuser un commentaire et le retirer de la file.",
          },
          {
            field: "can_delete_comments",
            label: "Supprimer",
            description: "Supprimer définitivement un commentaire.",
          },
        ],
      },
    ],
  },
  {
    key: "banAppeals",
    label: "Appels de bannissement",
    description: "Gestion des demandes de réexamen des bannissements.",
    groups: [
      {
        label: "Accès global",
        permissions: [
          {
            field: "can_review_ban_appeals",
            label: "Traitement complet",
            description:
              "Autorise l'intégralité des actions liées aux demandes de débannissement.",
            isAggregate: true,
          },
        ],
      },
      {
        label: "Actions détaillées",
        permissions: [
          {
            field: "can_view_ban_appeals",
            label: "Voir les demandes",
            description: "Consulter la liste des demandes de déban.",
          },
          {
            field: "can_accept_ban_appeals",
            label: "Accepter",
            description: "Lever un bannissement suite à une demande.",
          },
          {
            field: "can_reject_ban_appeals",
            label: "Rejeter",
            description: "Confirmer le maintien d'un bannissement.",
          },
          {
            field: "can_delete_ban_appeals",
            label: "Archiver",
            description: "Supprimer une demande traitée de l'historique.",
          },
        ],
      },
    ],
  },
  {
    key: "ipTools",
    label: "Gestion des IP",
    description: "Outils de contrôle des accès par adresse IP.",
    groups: [
      {
        label: "Blocages IP",
        permissions: [
          {
            field: "can_manage_ip_bans",
            label: "Administration des blocages",
            description: "Accès complet au module de blocage IP.",
            isAggregate: true,
          },
          {
            field: "can_view_ip_bans",
            label: "Voir les blocages",
            description: "Consulter la liste des IP actuellement bloquées.",
          },
          {
            field: "can_create_ip_bans",
            label: "Créer un blocage",
            description: "Ajouter un nouveau blocage IP.",
          },
          {
            field: "can_update_ip_bans",
            label: "Modifier un blocage",
            description: "Mettre à jour la portée ou la raison d'un blocage existant.",
          },
          {
            field: "can_delete_ip_bans",
            label: "Supprimer un blocage",
            description: "Retirer définitivement une règle de blocage.",
          },
          {
            field: "can_lift_ip_bans",
            label: "Lever un blocage",
            description: "Mettre fin à un blocage IP actif.",
          },
        ],
      },
      {
        label: "Réputation IP",
        permissions: [
          {
            field: "can_manage_ip_reputation",
            label: "Gestion complète",
            description: "Accès intégral aux outils de réputation IP.",
            isAggregate: true,
          },
          {
            field: "can_view_ip_reputation",
            label: "Voir les revues",
            description: "Consulter les profils IP à surveiller ou récemment blanchis.",
          },
          {
            field: "can_tag_ip_reputation",
            label: "Étiqueter",
            description: "Classer une IP comme sûre ou suspecte.",
          },
          {
            field: "can_clear_ip_reputation",
            label: "Purger",
            description: "Retirer les marquages de réputation d'une IP.",
          },
          {
            field: "can_import_ip_reputation",
            label: "Importer",
            description: "Importer des listes externes d'IP réputées.",
          },
        ],
      },
      {
        label: "Profils IP",
        permissions: [
          {
            field: "can_manage_ip_profiles",
            label: "Gestion complète",
            description: "Accès intégral aux profils IP détaillés.",
            isAggregate: true,
          },
          {
            field: "can_view_ip_profiles",
            label: "Voir les profils",
            description: "Consulter les informations et historiques liés à une IP.",
          },
          {
            field: "can_merge_ip_profiles",
            label: "Fusionner",
            description: "Fusionner plusieurs profils IP identiques.",
          },
          {
            field: "can_delete_ip_profiles",
            label: "Supprimer",
            description: "Retirer un profil IP de la base.",
          },
        ],
      },
    ],
  },
  {
    key: "submissions",
    label: "Contributions",
    description: "Gestion détaillée des propositions de pages.",
    groups: [
      {
        label: "Accès global",
        permissions: [
          {
            field: "can_review_submissions",
            label: "Validation complète",
            description: "Autorise toutes les actions de revue de contributions.",
            isAggregate: true,
          },
        ],
      },
      {
        label: "Actions détaillées",
        permissions: [
          {
            field: "can_view_submission_queue",
            label: "Voir la file",
            description: "Consulter les contributions en attente.",
          },
          {
            field: "can_accept_submissions",
            label: "Accepter",
            description: "Publier une contribution après relecture.",
          },
          {
            field: "can_reject_submissions",
            label: "Rejeter",
            description: "Refuser une contribution et prévenir son auteur.",
          },
          {
            field: "can_comment_on_submissions",
            label: "Commenter",
            description: "Ajouter une note interne lors du traitement d'une contribution.",
          },
        ],
      },
    ],
  },
  {
    key: "pages",
    label: "Pages",
    description: "Administration fine des contenus publiés.",
    groups: [
      {
        label: "Accès global",
        permissions: [
          {
            field: "can_manage_pages",
            label: "Gestion complète",
            description: "Accès à toutes les actions d'édition et de publication.",
            isAggregate: true,
          },
        ],
      },
      {
        label: "Consultation",
        permissions: [
          {
            field: "can_view_page_overview",
            label: "Voir l'administration",
            description: "Accéder au tableau de bord des pages.",
          },
          {
            field: "can_view_page_history",
            label: "Voir l'historique",
            description: "Consulter les différentes révisions d'une page.",
          },
        ],
      },
      {
        label: "Édition",
        permissions: [
          {
            field: "can_edit_pages",
            label: "Modifier",
            description: "Modifier le contenu d'une page existante.",
          },
          {
            field: "can_revert_page_history",
            label: "Restaurer une version",
            description: "Revenir à une révision antérieure.",
          },
          {
            field: "can_manage_page_tags",
            label: "Gérer les tags",
            description: "Ajouter ou retirer des tags associés aux pages.",
          },
        ],
      },
      {
        label: "Publication",
        permissions: [
          {
            field: "can_publish_pages",
            label: "Publier",
            description: "Publier immédiatement des pages ou modifications.",
          },
          {
            field: "can_unpublish_pages",
            label: "Dépublier",
            description: "Retirer une page publiée de la mise en ligne.",
          },
          {
            field: "can_schedule_pages",
            label: "Programmer",
            description: "Planifier la publication d'une page à l'avance.",
          },
        ],
      },
      {
        label: "Cycle de vie",
        permissions: [
          {
            field: "can_delete_pages",
            label: "Supprimer",
            description: "Envoyer une page à la corbeille.",
          },
          {
            field: "can_restore_pages",
            label: "Restaurer",
            description: "Restaurer une page depuis la corbeille.",
          },
        ],
      },
    ],
  },
  {
    key: "stats",
    label: "Statistiques",
    description: "Accès aux données d'audience.",
    groups: [
      {
        label: "Accès global",
        permissions: [
          {
            field: "can_view_stats",
            label: "Tableau complet",
            description: "Accéder à toutes les sections statistiques.",
            isAggregate: true,
          },
        ],
      },
      {
        label: "Niveaux de détail",
        permissions: [
          {
            field: "can_view_stats_basic",
            label: "Vue synthétique",
            description: "Afficher les indicateurs d'ensemble.",
          },
          {
            field: "can_view_stats_detailed",
            label: "Vue détaillée",
            description: "Explorer les données ventilées par période.",
          },
          {
            field: "can_export_stats",
            label: "Exporter",
            description: "Télécharger les statistiques sous forme de fichier.",
          },
        ],
      },
    ],
  },
  {
    key: "uploads",
    label: "Bibliothèque de médias",
    description: "Gestion des fichiers téléversés.",
    groups: [
      {
        label: "Accès global",
        permissions: [
          {
            field: "can_manage_uploads",
            label: "Gestion complète",
            description: "Autorise toutes les opérations sur les fichiers.",
            isAggregate: true,
          },
        ],
      },
      {
        label: "Actions détaillées",
        permissions: [
          {
            field: "can_view_uploads",
            label: "Parcourir",
            description: "Accéder à la bibliothèque d'images.",
          },
          {
            field: "can_upload_files",
            label: "Téléverser",
            description: "Ajouter de nouveaux fichiers.",
          },
          {
            field: "can_replace_files",
            label: "Remplacer",
            description: "Mettre à jour un fichier existant.",
          },
          {
            field: "can_delete_files",
            label: "Supprimer",
            description: "Retirer un fichier de la bibliothèque.",
          },
        ],
      },
    ],
  },
  {
    key: "settings",
    label: "Paramètres",
    description: "Configuration avancée du site.",
    groups: [
      {
        label: "Accès global",
        permissions: [
          {
            field: "can_manage_settings",
            label: "Gestion complète",
            description: "Autorise toutes les modifications de paramètres.",
            isAggregate: true,
          },
        ],
      },
      {
        label: "Sections",
        permissions: [
          {
            field: "can_update_general_settings",
            label: "Réglages généraux",
            description: "Modifier le nom, le logo ou le pied de page.",
          },
          {
            field: "can_manage_integrations",
            label: "Intégrations",
            description: "Configurer les webhooks et services externes.",
          },
          {
            field: "can_manage_navigation",
            label: "Navigation",
            description: "Gérer les menus et liens automatiques.",
          },
          {
            field: "can_manage_features",
            label: "Fonctionnalités",
            description: "Activer ou désactiver des modules optionnels.",
          },
        ],
      },
    ],
  },
  {
    key: "roles",
    label: "Rôles",
    description: "Création et maintenance des rôles personnalisés.",
    groups: [
      {
        label: "Accès global",
        permissions: [
          {
            field: "can_manage_roles",
            label: "Gestion complète",
            description: "Autorise toutes les actions sur les rôles.",
            isAggregate: true,
          },
        ],
      },
      {
        label: "Actions détaillées",
        permissions: [
          {
            field: "can_view_roles",
            label: "Voir les rôles",
            description: "Consulter la liste et les détails des rôles.",
          },
          {
            field: "can_create_roles",
            label: "Créer",
            description: "Ajouter un nouveau rôle.",
          },
          {
            field: "can_edit_roles",
            label: "Modifier",
            description: "Mettre à jour le nom, les couleurs ou les permissions d'un rôle.",
          },
          {
            field: "can_delete_roles",
            label: "Supprimer",
            description: "Retirer un rôle inutilisé.",
          },
          {
            field: "can_assign_roles",
            label: "Assigner",
            description: "Changer le rôle d'un utilisateur.",
          },
        ],
      },
    ],
  },
  {
    key: "users",
    label: "Utilisateurs",
    description: "Administration des comptes.",
    groups: [
      {
        label: "Accès global",
        permissions: [
          {
            field: "can_manage_users",
            label: "Gestion complète",
            description: "Autorise toutes les actions sur les utilisateurs.",
            isAggregate: true,
          },
        ],
      },
      {
        label: "Actions détaillées",
        permissions: [
          {
            field: "can_view_users",
            label: "Voir les utilisateurs",
            description: "Consulter la liste des comptes.",
          },
          {
            field: "can_invite_users",
            label: "Inviter",
            description: "Envoyer une invitation ou créer un compte.",
          },
          {
            field: "can_edit_users",
            label: "Modifier",
            description: "Mettre à jour les informations d'un compte.",
          },
          {
            field: "can_suspend_users",
            label: "Suspendre",
            description: "Désactiver temporairement un compte.",
          },
          {
            field: "can_delete_users",
            label: "Supprimer",
            description: "Retirer définitivement un compte utilisateur.",
          },
          {
            field: "can_reset_passwords",
            label: "Réinitialiser le mot de passe",
            description: "Forcer la définition d'un nouveau mot de passe.",
          },
          {
            field: "can_impersonate_users",
            label: "Se connecter à leur place",
            description: "Ouvrir une session au nom d'un utilisateur pour l'assister.",
          },
        ],
      },
    ],
  },
  {
    key: "badges",
    label: "Badges",
    description: "Création et attribution de distinctions visibles sur les profils.",
    groups: [
      {
        label: "Accès global",
        permissions: [
          {
            field: "can_manage_badges",
            label: "Gestion complète",
            description:
              "Autorise toutes les opérations sur les badges et leurs attributions.",
            isAggregate: true,
          },
        ],
      },
      {
        label: "Actions détaillées",
        permissions: [
          {
            field: "can_view_badges",
            label: "Voir les badges",
            description: "Consulter la liste des badges disponibles et leurs détenteurs.",
          },
          {
            field: "can_create_badges",
            label: "Créer",
            description: "Ajouter un nouveau badge à la collection.",
          },
          {
            field: "can_edit_badges",
            label: "Modifier",
            description: "Mettre à jour le nom, l'emoji ou la description d'un badge.",
          },
          {
            field: "can_delete_badges",
            label: "Supprimer",
            description: "Retirer un badge et toutes ses attributions.",
          },
          {
            field: "can_assign_badges",
            label: "Attribuer",
            description: "Décerner un badge à un utilisateur.",
          },
          {
            field: "can_revoke_badges",
            label: "Retirer",
            description: "Retirer un badge précédemment attribué.",
          },
        ],
      },
    ],
  },
  {
    key: "likes",
    label: "Mentions J'aime",
    description: "Contrôle des réactions des lecteurs.",
    groups: [
      {
        label: "Accès global",
        permissions: [
          {
            field: "can_manage_likes",
            label: "Gestion complète",
            description: "Autorise toutes les actions sur les likes.",
            isAggregate: true,
          },
        ],
      },
      {
        label: "Actions détaillées",
        permissions: [
          {
            field: "can_view_likes",
            label: "Voir les likes",
            description: "Consulter le détail des mentions J'aime.",
          },
          {
            field: "can_remove_likes",
            label: "Retirer",
            description: "Supprimer une mention J'aime suspecte.",
          },
        ],
      },
    ],
  },
  {
    key: "trash",
    label: "Corbeille",
    description: "Gestion des contenus supprimés.",
    groups: [
      {
        label: "Accès global",
        permissions: [
          {
            field: "can_manage_trash",
            label: "Gestion complète",
            description: "Autorise toutes les actions sur la corbeille.",
            isAggregate: true,
          },
        ],
      },
      {
        label: "Actions détaillées",
        permissions: [
          {
            field: "can_view_trash",
            label: "Voir la corbeille",
            description: "Consulter les éléments supprimés.",
          },
          {
            field: "can_restore_trash",
            label: "Restaurer",
            description: "Remettre un contenu supprimé en ligne.",
          },
          {
            field: "can_purge_trash",
            label: "Purger",
            description: "Supprimer définitivement un contenu.",
          },
        ],
      },
    ],
  },
  {
    key: "events",
    label: "Journal d'événements",
    description: "Suivi des actions administratives.",
    groups: [
      {
        label: "Accès global",
        permissions: [
          {
            field: "can_view_events",
            label: "Journal complet",
            description: "Accéder à l'historique des événements.",
            isAggregate: true,
          },
        ],
      },
      {
        label: "Actions détaillées",
        permissions: [
          {
            field: "can_view_event_log",
            label: "Consulter",
            description: "Voir la liste des événements enregistrés.",
          },
          {
            field: "can_export_event_log",
            label: "Exporter",
            description: "Télécharger le journal au format CSV.",
          },
        ],
      },
    ],
  },
  {
    key: "snowflakes",
    label: "Identifiants",
    description: "Inspection des identifiants techniques.",
    groups: [
      {
        label: "Accès global",
        permissions: [
          {
            field: "can_view_snowflakes",
            label: "Identifiants complets",
            description: "Afficher les identifiants internes dans l'interface.",
            isAggregate: true,
          },
        ],
      },
      {
        label: "Actions détaillées",
        permissions: [
          {
            field: "can_lookup_snowflake_history",
            label: "Rechercher",
            description: "Consulter l'historique associé à un identifiant.",
          },
        ],
      },
    ],
  },
  {
    key: "announcements",
    label: "Annonces",
    description: "Diffusion et planification des communications officielles.",
    groups: [
      {
        label: "Accès global",
        permissions: [
          {
            field: "can_manage_announcements",
            label: "Gestion complète",
            description: "Autorise toutes les actions sur les annonces publiques.",
            isAggregate: true,
          },
        ],
      },
      {
        label: "Actions détaillées",
        permissions: [
          {
            field: "can_view_announcements",
            label: "Voir les annonces",
            description: "Consulter l'historique et les messages programmés.",
          },
          {
            field: "can_create_announcements",
            label: "Créer",
            description: "Rédiger et enregistrer une nouvelle annonce.",
          },
          {
            field: "can_schedule_announcements",
            label: "Programmer",
            description: "Planifier la publication d'une annonce.",
          },
          {
            field: "can_archive_announcements",
            label: "Archiver",
            description: "Retirer une annonce et l'ajouter aux archives.",
          },
        ],
      },
    ],
  },
  {
    key: "notifications",
    label: "Notifications",
    description: "Envoi et personnalisation des notifications utilisateurs.",
    groups: [
      {
        label: "Accès global",
        permissions: [
          {
            field: "can_manage_notifications",
            label: "Gestion complète",
            description: "Autorise l'administration de tous les canaux de notification.",
            isAggregate: true,
          },
        ],
      },
      {
        label: "Canaux",
        permissions: [
          {
            field: "can_view_notifications",
            label: "Voir les envois",
            description: "Consulter les notifications envoyées et programmées.",
          },
          {
            field: "can_send_notifications",
            label: "Envoyer",
            description: "Déclencher l'envoi immédiat d'une notification.",
          },
          {
            field: "can_configure_notification_channels",
            label: "Configurer les canaux",
            description: "Activer ou désactiver les canaux (email, push, webhook).",
          },
          {
            field: "can_manage_notification_templates",
            label: "Gérer les modèles",
            description: "Créer et modifier les modèles de notification.",
          },
        ],
      },
    ],
  },
  {
    key: "automation",
    label: "Automatisation",
    description: "Orchestration des flux de travail automatisés.",
    groups: [
      {
        label: "Accès global",
        permissions: [
          {
            field: "can_manage_automations",
            label: "Gestion complète",
            description: "Autorise toutes les actions sur les automatisations.",
            isAggregate: true,
          },
        ],
      },
      {
        label: "Workflows",
        permissions: [
          {
            field: "can_view_automations",
            label: "Voir les workflows",
            description: "Consulter les automatisations existantes et leur état.",
          },
          {
            field: "can_create_automations",
            label: "Créer",
            description: "Mettre en place un nouveau workflow automatisé.",
          },
          {
            field: "can_edit_automations",
            label: "Modifier",
            description: "Ajuster les déclencheurs ou actions d'une automatisation.",
          },
          {
            field: "can_delete_automations",
            label: "Supprimer",
            description: "Retirer un workflow devenu inutile.",
          },
          {
            field: "can_run_automations",
            label: "Exécuter",
            description: "Déclencher manuellement une automatisation à la demande.",
          },
        ],
      },
      {
        label: "Intégrations",
        permissions: [
          {
            field: "can_manage_webhooks",
            label: "Gérer les webhooks",
            description: "Créer ou désactiver des webhooks connectés aux workflows.",
          },
        ],
      },
    ],
  },
  {
    key: "seo",
    label: "Référencement",
    description: "Optimisation de la visibilité des contenus.",
    groups: [
      {
        label: "Accès global",
        permissions: [
          {
            field: "can_manage_seo",
            label: "Gestion complète",
            description: "Autorise toutes les optimisations SEO du site.",
            isAggregate: true,
          },
        ],
      },
      {
        label: "Optimisations",
        permissions: [
          {
            field: "can_view_seo_reports",
            label: "Voir les rapports",
            description: "Consulter les audits SEO et leurs recommandations.",
          },
          {
            field: "can_edit_seo_metadata",
            label: "Modifier les métadonnées",
            description: "Mettre à jour titres, descriptions et balises canoniques.",
          },
          {
            field: "can_manage_redirects",
            label: "Gérer les redirections",
            description: "Ajouter ou modifier des redirections d'URL.",
          },
          {
            field: "can_audit_internal_links",
            label: "Auditer les liens",
            description: "Analyser les liens internes cassés ou orphelins.",
          },
        ],
      },
    ],
  },
  {
    key: "community",
    label: "Communauté",
    description: "Animation et modération des espaces communautaires.",
    groups: [
      {
        label: "Accès global",
        permissions: [
          {
            field: "can_manage_community",
            label: "Gestion complète",
            description: "Autorise toutes les actions communautaires avancées.",
            isAggregate: true,
          },
        ],
      },
      {
        label: "Forums",
        permissions: [
          {
            field: "can_view_forums",
            label: "Voir les forums",
            description: "Accéder aux discussions communautaires internes.",
          },
          {
            field: "can_moderate_forums",
            label: "Modérer",
            description: "Éditer ou supprimer des messages dans les forums.",
          },
          {
            field: "can_feature_forum_topics",
            label: "Mettre en avant",
            description: "Épingler ou recommander des discussions importantes.",
          },
        ],
      },
      {
        label: "Groupes",
        permissions: [
          {
            field: "can_manage_user_groups",
            label: "Gérer les groupes",
            description: "Créer, renommer ou dissoudre des groupes communautaires.",
          },
        ],
      },
    ],
  },
];

export function flattenPermissionDefinitions(categories = PERMISSION_CATEGORIES) {
  const definitions = [];
  for (const category of categories) {
    const groups = Array.isArray(category.groups) ? category.groups : [];
    for (const group of groups) {
      const permissions = Array.isArray(group.permissions) ? group.permissions : [];
      for (const permission of permissions) {
        if (!permission || typeof permission.field !== "string") {
          continue;
        }
        definitions.push({
          ...permission,
          category: category.key,
          categoryLabel: category.label,
          group: group.label || null,
        });
      }
    }
  }
  return definitions;
}

export const PERMISSION_DEFINITIONS = flattenPermissionDefinitions();

export const PERMISSION_METADATA = PERMISSION_DEFINITIONS.reduce((acc, definition) => {
  acc[definition.field] = definition;
  return acc;
}, {});

export const PERMISSION_DEPENDENCIES = {
  is_moderator: [
    "is_helper",
    "is_contributor",
    "can_comment",
    "can_submit_pages",
    "can_moderate_comments",
    "can_review_submissions",
    "can_review_ban_appeals",
    "can_manage_likes",
    "can_manage_trash",
    "can_view_stats",
  ],
  is_contributor: [
    "can_comment",
    "can_submit_pages",
    "can_view_page_overview",
    "can_edit_pages",
    "can_publish_pages",
    "can_view_page_history",
  ],
  is_helper: ["can_comment"],
  can_moderate_comments: [
    "can_view_comment_queue",
    "can_approve_comments",
    "can_reject_comments",
    "can_delete_comments",
  ],
  can_review_ban_appeals: [
    "can_view_ban_appeals",
    "can_accept_ban_appeals",
    "can_reject_ban_appeals",
    "can_delete_ban_appeals",
  ],
  can_manage_ip_bans: [
    "can_view_ip_bans",
    "can_create_ip_bans",
    "can_update_ip_bans",
    "can_delete_ip_bans",
    "can_lift_ip_bans",
  ],
  can_manage_ip_reputation: [
    "can_view_ip_reputation",
    "can_tag_ip_reputation",
    "can_clear_ip_reputation",
    "can_import_ip_reputation",
  ],
  can_manage_ip_profiles: [
    "can_view_ip_profiles",
    "can_merge_ip_profiles",
    "can_delete_ip_profiles",
  ],
  can_review_submissions: [
    "can_view_submission_queue",
    "can_accept_submissions",
    "can_reject_submissions",
    "can_comment_on_submissions",
  ],
  can_manage_pages: [
    "can_view_page_overview",
    "can_edit_pages",
    "can_publish_pages",
    "can_unpublish_pages",
    "can_delete_pages",
    "can_restore_pages",
    "can_schedule_pages",
    "can_manage_page_tags",
    "can_view_page_history",
    "can_revert_page_history",
  ],
  can_view_stats: [
    "can_view_stats_basic",
    "can_view_stats_detailed",
    "can_export_stats",
  ],
  can_manage_uploads: [
    "can_view_uploads",
    "can_upload_files",
    "can_replace_files",
    "can_delete_files",
  ],
  can_manage_settings: [
    "can_update_general_settings",
    "can_manage_integrations",
    "can_manage_navigation",
    "can_manage_features",
  ],
  can_manage_roles: [
    "can_view_roles",
    "can_create_roles",
    "can_edit_roles",
    "can_delete_roles",
    "can_assign_roles",
  ],
  can_manage_users: [
    "can_view_users",
    "can_invite_users",
    "can_edit_users",
    "can_suspend_users",
    "can_delete_users",
    "can_reset_passwords",
    "can_impersonate_users",
    "can_assign_roles",
  ],
  can_manage_badges: [
    "can_view_badges",
    "can_create_badges",
    "can_edit_badges",
    "can_delete_badges",
    "can_assign_badges",
    "can_revoke_badges",
  ],
  can_create_badges: ["can_view_badges"],
  can_edit_badges: ["can_view_badges"],
  can_delete_badges: ["can_view_badges"],
  can_assign_badges: ["can_view_badges"],
  can_revoke_badges: ["can_view_badges"],
  can_manage_likes: ["can_view_likes", "can_remove_likes"],
  can_manage_trash: ["can_view_trash", "can_restore_trash", "can_purge_trash"],
  can_view_events: ["can_view_event_log", "can_export_event_log"],
  can_view_snowflakes: ["can_lookup_snowflake_history"],
  can_manage_announcements: [
    "can_view_announcements",
    "can_create_announcements",
    "can_schedule_announcements",
    "can_archive_announcements",
  ],
  can_manage_notifications: [
    "can_view_notifications",
    "can_send_notifications",
    "can_configure_notification_channels",
    "can_manage_notification_templates",
  ],
  can_manage_automations: [
    "can_view_automations",
    "can_create_automations",
    "can_edit_automations",
    "can_delete_automations",
    "can_run_automations",
    "can_manage_webhooks",
  ],
  can_manage_seo: [
    "can_view_seo_reports",
    "can_edit_seo_metadata",
    "can_manage_redirects",
    "can_audit_internal_links",
  ],
  can_manage_community: [
    "can_view_forums",
    "can_moderate_forums",
    "can_feature_forum_topics",
    "can_manage_user_groups",
  ],
};

export function getAllPermissionFields() {
  return PERMISSION_DEFINITIONS.map((definition) => definition.field);
}
