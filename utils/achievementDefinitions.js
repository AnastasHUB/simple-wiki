export const ACHIEVEMENT_DEFINITIONS = [
  {
    key: "member_one_week",
    name: "Membre engagé",
    description: "Actif depuis au moins 7 jours sur le wiki.",
    emoji: "📅",
    type: "membership_duration",
    options: { days: 7 },
  },
  {
    key: "member_one_year",
    name: "Ancien de la communauté",
    description: "Participe depuis plus d'un an.",
    emoji: "🗓️",
    type: "membership_duration",
    options: { days: 365 },
  },
  {
    key: "first_article",
    name: "Premier article",
    description: "A publié son premier article.",
    emoji: "📝",
    type: "page_count",
    options: { count: 1 },
  },
  {
    key: "five_articles",
    name: "Auteur prolifique",
    description: "A publié au moins cinq articles.",
    emoji: "✍️",
    type: "page_count",
    options: { count: 5 },
  },
];
