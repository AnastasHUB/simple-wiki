const HEX_COLOR_PATTERN = /^#?([0-9a-fA-F]{6})$/;

function normalizeHexColor(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const trimmed = String(value).trim();
  if (!trimmed) {
    return null;
  }
  const match = trimmed.match(HEX_COLOR_PATTERN);
  if (!match) {
    throw new Error(
      "Couleur de rôle invalide. Utilisez un code hexadécimal à 6 caractères (ex: #3498DB).",
    );
  }
  return `#${match[1].toUpperCase()}`;
}

function coerceMode(rawMode) {
  if (!rawMode) {
    return null;
  }
  const normalized = String(rawMode).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (["solid", "single", "simple", "color"].includes(normalized)) {
    return "solid";
  }
  if (["gradient", "degrade", "degradé", "dual", "double"].includes(normalized)) {
    return "gradient";
  }
  if (["rainbow", "arc", "arc-en-ciel", "multi", "animated"].includes(normalized)) {
    return "rainbow";
  }
  return ["solid", "gradient", "rainbow"].includes(normalized) ? normalized : null;
}

export function normalizeRoleColorScheme(raw) {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) {
      return null;
    }
    try {
      const parsed = JSON.parse(trimmed);
      return normalizeRoleColorScheme(parsed);
    } catch (_err) {
      const solid = normalizeHexColor(trimmed);
      if (!solid) {
        return null;
      }
      return { mode: "solid", colors: [solid] };
    }
  }
  if (typeof raw === "object") {
    if (raw instanceof Array) {
      if (!raw.length) {
        return null;
      }
      if (raw.length === 1) {
        return normalizeRoleColorScheme({ mode: "solid", colors: raw });
      }
      if (raw.length === 2) {
        return normalizeRoleColorScheme({ mode: "gradient", colors: raw });
      }
      return normalizeRoleColorScheme({ mode: "rainbow", colors: raw.slice(0, 5) });
    }
    const mode = coerceMode(raw.mode || raw.type || raw.kind || raw.style);
    if (!mode) {
      if (raw.solid) {
        return normalizeRoleColorScheme({ mode: "solid", colors: [raw.solid] });
      }
      if (raw.gradient || raw.start || raw.end) {
        const start = raw.gradient?.[0] || raw.start || raw.primary || raw.first;
        const end = raw.gradient?.[1] || raw.end || raw.secondary || raw.second;
        return normalizeRoleColorScheme({ mode: "gradient", colors: [start, end] });
      }
      if (raw.rainbow) {
        return normalizeRoleColorScheme({ mode: "rainbow", colors: raw.rainbow });
      }
      return null;
    }
    let colorSource = raw.colors;
    if (!Array.isArray(colorSource)) {
      if (mode === "solid") {
        colorSource = [raw.color || raw.value || raw.solid];
      } else if (mode === "gradient") {
        colorSource = [
          raw.start || raw.first || raw.primary || raw.colorA || raw.color1,
          raw.end || raw.second || raw.secondary || raw.colorB || raw.color2,
        ];
      } else {
        colorSource = [
          raw.color1 ?? raw.first,
          raw.color2 ?? raw.second,
          raw.color3 ?? raw.third,
          raw.color4 ?? raw.fourth,
          raw.color5 ?? raw.fifth,
        ];
      }
    }
    const sanitizedColors = [];
    if (Array.isArray(colorSource)) {
      for (const value of colorSource) {
        const color = normalizeHexColor(value);
        if (color) {
          sanitizedColors.push(color);
        }
      }
    }
    const minimumCounts = { solid: 1, gradient: 2, rainbow: 2 };
    const maximumCounts = { gradient: 5, rainbow: 5 };
    const minimum = minimumCounts[mode] || 0;
    const maximum = maximumCounts[mode] || sanitizedColors.length;
    if (sanitizedColors.length < minimum) {
      if (sanitizedColors.length === 0) {
        return null;
      }
      throw new Error(
        mode === "solid"
          ? "Indiquez une couleur hexadécimale pour ce rôle."
          : mode === "gradient"
            ? "Un dégradé nécessite au moins deux couleurs hexadécimales."
            : "Un arc-en-ciel animé nécessite au moins deux couleurs hexadécimales.",
      );
    }
    const limited = sanitizedColors.slice(0, maximum || sanitizedColors.length);
    return { mode, colors: limited };
  }
  return null;
}

export function serializeRoleColorScheme(scheme) {
  const normalized = normalizeRoleColorScheme(scheme);
  if (!normalized) {
    return null;
  }
  return JSON.stringify(normalized);
}

export function parseStoredRoleColor(value) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    try {
      const parsed = JSON.parse(trimmed);
      return normalizeRoleColorScheme(parsed);
    } catch (_err) {
      try {
        return normalizeRoleColorScheme(trimmed);
      } catch (parseErr) {
        console.warn("Couleur de rôle enregistrée invalide ignorée", parseErr);
        return null;
      }
    }
  }
  if (typeof value === "object") {
    try {
      return normalizeRoleColorScheme(value);
    } catch (err) {
      console.warn("Couleur de rôle invalide fournie, ignorée", err);
      return null;
    }
  }
  return null;
}

function buildGradient(mode, colors) {
  if (mode === "gradient" && colors.length >= 2) {
    const stopCount = colors.length - 1;
    const stops = colors.map((color, index) => {
      const position = stopCount > 0 ? Math.round((index / stopCount) * 100) : 0;
      return `${color} ${position}%`;
    });
    return `linear-gradient(135deg, ${stops.join(", ")})`;
  }
  if (mode === "rainbow" && colors.length >= 2) {
    const step = 100 / Math.max(colors.length, 1);
    const stops = colors.map((color, index) => `${color} ${Math.round(index * step)}%`);
    stops.push(`${colors[0]} 100%`);
    return `linear-gradient(120deg, ${stops.join(", ")})`;
  }
  return null;
}

export function buildRoleColorPresentation(scheme) {
  const normalized = normalizeRoleColorScheme(scheme);
  if (!normalized) {
    return {
      mode: null,
      colors: [],
      className: "",
      style: "",
      label: "Couleur par défaut",
      hasColor: false,
      fallbackColor: null,
    };
  }
  const { mode, colors } = normalized;
  const fallbackColor = colors[0] || null;
  const gradient = buildGradient(mode, colors);
  const styleParts = [];
  colors.forEach((color, index) => {
    styleParts.push(`--role-color-${index + 1}: ${color}`);
  });
  if (fallbackColor) {
    styleParts.push(`--role-fallback-color: ${fallbackColor}`);
  }
  if (gradient) {
    styleParts.push(`--role-gradient: ${gradient}`);
  }
  styleParts.push("--role-background-position: 0% 50%");
  if (mode === "gradient") {
    styleParts.push("--role-background-size: 200% 200%");
    styleParts.push("--role-animation: none");
  } else if (mode === "rainbow") {
    styleParts.push("--role-background-size: 400% 100%");
    styleParts.push("--role-animation: role-rainbow 8s linear infinite");
  } else {
    styleParts.push("--role-background-size: 100% 100%");
    styleParts.push("--role-animation: none");
  }
  let label = colors.join(" → ");
  if (mode === "solid" && fallbackColor) {
    label = fallbackColor;
  } else if (mode === "gradient") {
    label = `Dégradé ${colors.join(" → ")}`;
  } else if (mode === "rainbow") {
    label = `Arc-en-ciel ${colors.join(" → ")}`;
  }
  return {
    mode,
    colors,
    className: `role-color--${mode}`,
    style: styleParts.join("; "),
    label,
    hasColor: true,
    fallbackColor,
  };
}

export function extractRoleColorFromBody(body = {}) {
  if (!body || typeof body !== "object") {
    return null;
  }
  if (Object.prototype.hasOwnProperty.call(body, "color")) {
    const raw = body.color;
    if (raw === null || raw === undefined || raw === "") {
      return null;
    }
    return normalizeRoleColorScheme(raw);
  }
  const rawMode = body.color_mode || body.colorMode || body.roleColorMode;
  const mode = coerceMode(rawMode);
  if (!mode) {
    return null;
  }
  if (mode === "solid") {
    const rawColor =
      body.color_solid || body.colorSolid || body.primary_color || body.color_primary;
    if (!rawColor) {
      throw new Error("Indiquez une couleur hexadécimale pour ce rôle.");
    }
    return normalizeRoleColorScheme({ mode: "solid", colors: [rawColor] });
  }
  if (mode === "gradient") {
    let values =
      body.color_gradient ||
      body.colorGradient ||
      body.gradient_colors ||
      body.gradientColors;
    if (!values || (typeof values === "string" && !values.trim())) {
      const start =
        body.color_gradient_start ||
        body.colorGradientStart ||
        body.color_start ||
        body.color_primary ||
        body.colorPrimary;
      const end =
        body.color_gradient_end ||
        body.colorGradientEnd ||
        body.color_end ||
        body.color_secondary ||
        body.colorSecondary;
      values = [start, end];
    }
    if (!Array.isArray(values)) {
      values = [values];
    }
    return normalizeRoleColorScheme({ mode: "gradient", colors: values });
  }
  if (mode === "rainbow") {
    let values =
      body.color_rainbow ||
      body.colorRainbow ||
      body.rainbow_colors ||
      body.rainbowColors;
    if (!values || (typeof values === "string" && !values.trim())) {
      const collected = [];
      for (let index = 1; index <= 5; index += 1) {
        const value =
          body[`color_rainbow_${index}`] ||
          body[`colorRainbow${index}`] ||
          body[`colorRainbow_${index}`] ||
          body[`rainbow_color_${index}`] ||
          body[`rainbowColor${index}`];
        collected.push(value);
      }
      values = collected;
    }
    if (!Array.isArray(values)) {
      values = [values];
    }
    return normalizeRoleColorScheme({ mode: "rainbow", colors: values });
  }
  return null;
}
