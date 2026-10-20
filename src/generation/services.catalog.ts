/**
 * Каталог услуг: пресеты, шаблоны промптов и настройки моделей — данными, а не кодом.
 * Позже переедет в БД, чтобы менять без деплоя.
 */

export const SERVICE_IDS = [
  'marketplace_card',
  'product_shot',
  'video_ad',
  'avatar',
  'content_optimization',
] as const;

export type ServiceId = (typeof SERVICE_IDS)[number];

export interface Preset {
  id: string;
  title: string;
  description: string;
  /** Англоязычная часть промпта, к ней добавляется описание товара от пользователя */
  prompt: string;
}

export interface MarketplaceSpec {
  id: string;
  title: string;
  width: number;
  height: number;
  /** Подпись в интерфейсе: требования площадок меняются, значения нужно перепроверять */
  note: string;
}

export interface VideoModelOption {
  id: string;
  title: string;
  description: string;
  model: string;
  resolution: string;
  durations: number[];
  /** Цена за секунду в долларах — для оценки стоимости до запуска */
  usdPerSecond: number;
}

export interface ServiceDefinition {
  id: ServiceId;
  title: string;
  description: string;
  kind: 'image' | 'video' | 'text';
  /** Сколько исходных изображений принимает услуга */
  inputImages: { min: number; max: number; label: string };
  presets: Preset[];
  /** Сколько вариантов можно запросить за раз */
  maxOutputs: number;
  imageModel?: string;
  marketplaces?: MarketplaceSpec[];
  videoModels?: VideoModelOption[];
  aspectRatios?: { id: string; title: string }[];
  /** Услуга работает с лицами реальных людей — нужно подтверждение согласия */
  requiresConsent?: boolean;
}

const IMAGE_MODEL = 'google/gemini-3.1-flash-lite-image';

/** Общий хвост промпта: держит фотореализм и убирает выдуманный текст на картинке */
export const PHOTO_GUARDRAILS =
  'Photorealistic commercial photography, natural lighting, sharp focus, high detail. ' +
  'Do not add any text, letters, watermarks or logos to the image.';

/** Отдельно для съёмки товара: сам товар перерисовывать нельзя */
export const PRODUCT_GUARDRAILS =
  'Keep the product itself exactly as in the source photo: identical shape, proportions, colors, ' +
  'materials and any printed labels. Only change the background, scene and lighting. ' +
  PHOTO_GUARDRAILS;

export const SERVICES: ServiceDefinition[] = [
  {
    id: 'content_optimization', title: 'Content optimization',
    description: 'Turn your video idea into a TikTok caption, hook and relevant hashtags.',
    kind: 'text', inputImages: { min: 0, max: 0, label: '' }, maxOutputs: 1,
    presets: [{ id: 'tiktok', title: 'TikTok description', description: 'A hook, caption and hashtags for your next post.', prompt: '' }],
  },
  {
    id: 'marketplace_card',
    title: 'Marketplace listing card',
    description:
      'Product shot on the right background, cropped to the marketplace spec. Headline and badge are rendered by us, not by the model.',
    kind: 'image',
    inputImages: { min: 1, max: 1, label: 'Product photo' },
    maxOutputs: 4,
    imageModel: IMAGE_MODEL,
    marketplaces: [
      {
        id: 'wildberries',
        title: 'Wildberries',
        width: 900,
        height: 1200,
        note: 'Portrait 3:4',
      },
      {
        id: 'ozon',
        title: 'Ozon',
        width: 1200,
        height: 1600,
        note: 'Portrait 3:4',
      },
      {
        id: 'yandex_market',
        title: 'Yandex Market',
        width: 1000,
        height: 1000,
        note: 'Square 1:1',
      },
    ],
    presets: [
      {
        id: 'white',
        title: 'White background',
        description:
          'Main listing photo: product on clean white with a soft shadow',
        prompt:
          'Place the product on a pure white seamless background with a soft natural contact shadow, ' +
          'centered, even studio lighting, e-commerce main listing photo. ' +
          PRODUCT_GUARDRAILS,
      },
      {
        id: 'lifestyle',
        title: 'In context',
        description: 'Product in a real-life scene that shows how it is used',
        prompt:
          'Place the product in a tasteful real-life interior scene relevant to its use, soft daylight, ' +
          'shallow depth of field, lifestyle e-commerce photography. ' +
          PRODUCT_GUARDRAILS,
      },
      {
        id: 'infographic',
        title: 'Infographic ready',
        description: 'Clear space at the top for a headline and badge',
        prompt:
          'Place the product on a clean light gradient background (soft beige to white), product in the lower ' +
          'two thirds of the frame, empty uncluttered space in the top third for a text overlay. ' +
          PRODUCT_GUARDRAILS,
      },
    ],
  },
  {
    id: 'product_shot',
    title: 'Product photography',
    description:
      'Turn one product photo into a set of studio and lifestyle shots.',
    kind: 'image',
    inputImages: { min: 1, max: 1, label: 'Product photo' },
    maxOutputs: 4,
    imageModel: IMAGE_MODEL,
    aspectRatios: [
      { id: '1:1', title: 'Square 1:1' },
      { id: '4:5', title: 'Portrait 4:5' },
      { id: '16:9', title: 'Landscape 16:9' },
    ],
    presets: [
      {
        id: 'studio',
        title: 'Studio',
        description: 'Soft light, neutral podium, catalogue look',
        prompt:
          'Studio product shot on a neutral seamless backdrop with a subtle podium, soft diffused key light ' +
          'and gentle reflections. ' +
          PRODUCT_GUARDRAILS,
      },
      {
        id: 'marble',
        title: 'Marble and stone',
        description: 'Premium presentation on a stone surface',
        prompt:
          'Premium product shot on a marble surface with natural window light, soft shadows, minimal props. ' +
          PRODUCT_GUARDRAILS,
      },
      {
        id: 'nature',
        title: 'Natural materials',
        description: 'Wood, linen and dried botanicals — for beauty and food',
        prompt:
          'Product shot on natural materials: warm wood and linen textures, dried botanicals as subtle props, ' +
          'warm morning light. ' +
          PRODUCT_GUARDRAILS,
      },
      {
        id: 'color',
        title: 'Color block',
        description: 'Bold solid background for ad banners',
        prompt:
          'Product shot on a bold solid color background complementing the product, hard directional light, ' +
          'crisp geometric shadow, modern advertising style. ' +
          PRODUCT_GUARDRAILS,
      },
    ],
  },
  {
    id: 'video_ad',
    title: 'Video ad',
    description:
      'Vertical clip for Reels and Shorts, from a description or a product photo.',
    kind: 'video',
    inputImages: { min: 0, max: 1, label: 'First frame (optional)' },
    maxOutputs: 1,
    aspectRatios: [
      { id: '9:16', title: 'Vertical 9:16' },
      { id: '1:1', title: 'Square 1:1' },
      { id: '16:9', title: 'Landscape 16:9' },
    ],
    videoModels: [
      {
        id: 'draft',
        title: 'Draft',
        description: 'Cheap, for testing ideas',
        model: 'alibaba/wan-3.0',
        resolution: '480p',
        durations: Array.from({ length: 29 }, (_, index) => index + 2),
        usdPerSecond: 0.05,
      },
      {
        id: 'standard',
        title: 'Standard',
        description: 'Balanced price and quality, 720p',
        model: 'alibaba/wan-3.0',
        resolution: '720p',
        durations: Array.from({ length: 29 }, (_, index) => index + 2),
        usdPerSecond: 0.1,
      },
      {
        id: 'premium',
        title: 'Premium',
        description: 'Detailed video with audio, for final cuts',
        model: 'google/veo-3.1-fast',
        resolution: '1080p',
        durations: [4, 6, 8],
        usdPerSecond: 0.12,
      },
    ],
    presets: [
      {
        id: 'custom',
        title: 'Custom prompt',
        description: 'Describe your own scene, action, camera movement and style',
        prompt: '',
      },
      {
        id: 'product_demo',
        title: 'Product demo',
        description: 'Slow camera orbit around the product',
        prompt:
          'Slow cinematic orbit around the product, shallow depth of field, premium advertising look, ' +
          'clean background, smooth camera motion.',
      },
      {
        id: 'unboxing',
        title: 'Unboxing',
        description: 'Hands opening the package in close-up',
        prompt:
          'Close-up hands unboxing the product on a clean table, natural daylight, satisfying tactile detail, ' +
          'handheld but stable camera.',
      },
      {
        id: 'lifestyle',
        title: 'Lifestyle scene',
        description: 'The product in real everyday use',
        prompt:
          'A short lifestyle scene showing the product in real everyday use, warm natural light, ' +
          'authentic documentary feel, subtle camera movement.',
      },
      {
        id: 'atmosphere',
        title: 'Atmospheric b-roll',
        description: 'Textures and light, room for text on top',
        prompt:
          'Atmospheric abstract background footage with soft moving light, textures and bokeh, ' +
          'muted palette, room for text overlay, slow motion.',
      },
    ],
  },
  {
    id: 'avatar',
    title: 'Portraits and avatars',
    description:
      'Professional portraits from ordinary selfies. Upload only your own photos, or photos you have consent for.',
    kind: 'image',
    inputImages: {
      min: 1,
      max: 3,
      label: 'Selfies (1–3 photos, different angles work best)',
    },
    maxOutputs: 4,
    imageModel: IMAGE_MODEL,
    requiresConsent: true,
    presets: [
      {
        id: 'business',
        title: 'Business headshot',
        description: 'For a company page or a CV',
        prompt:
          'Professional corporate headshot of the same person from the reference photos: keep the face, ' +
          'hairstyle and skin tone identical and recognizable. Neutral office background, soft key light, ' +
          'business casual clothing, confident friendly expression. ' +
          PHOTO_GUARDRAILS,
      },
      {
        id: 'linkedin',
        title: 'Social profile',
        description: 'Bright, friendly, close crop',
        prompt:
          'Friendly social media profile portrait of the same person from the reference photos: identical face ' +
          'and features. Bright airy background, natural window light, relaxed smile, close crop. ' +
          PHOTO_GUARDRAILS,
      },
      {
        id: 'creative',
        title: 'Creative',
        description: 'Colored light and an editorial mood',
        prompt:
          'Creative studio portrait of the same person from the reference photos: identical face and features. ' +
          'Colored gel lighting, dark background, editorial fashion look. ' +
          PHOTO_GUARDRAILS,
      },
      {
        id: 'outdoor',
        title: 'Outdoor',
        description: 'City background, natural light',
        prompt:
          'Outdoor portrait of the same person from the reference photos: identical face and features. ' +
          'City street background with soft bokeh, golden hour light, casual clothing. ' +
          PHOTO_GUARDRAILS,
      },
    ],
  },
];

export function getService(id: string): ServiceDefinition | undefined {
  return SERVICES.find((service) => service.id === id);
}

export function getPreset(
  service: ServiceDefinition,
  id: string,
): Preset | undefined {
  return service.presets.find((preset) => preset.id === id);
}
