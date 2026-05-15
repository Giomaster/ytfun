import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { compileManifest } from "./compiler.js";
import { assertFfmpegAvailable } from "./ffmpeg.js";
import { writeJsonFile } from "./io.js";
import type { EditPlan, RightsManifest } from "./types.js";

interface DemoSlide {
  id: string;
  title: string;
  subtitle: string;
  metric: string;
  accent: string;
  background: string;
  duration: number;
}

const slides: DemoSlide[] = [
  {
    id: "demo-01-hook",
    title: "YTfun Trend Studio",
    subtitle: "Um bot editorial que escolhe oportunidades antes de editar videos.",
    metric: "Objetivo: encontrar videos faturaveis, viaveis e em alta",
    accent: "0x2DD4BF",
    background: "0x101820",
    duration: 4,
  },
  {
    id: "demo-02-trend",
    title: "1. Tendencia",
    subtitle: "Views, velocidade, frescor, engajamento e aderencia ao tema.",
    metric: "trendScore: 86/100",
    accent: "0x38BDF8",
    background: "0x13293D",
    duration: 4,
  },
  {
    id: "demo-03-complexity",
    title: "2. Complexidade",
    subtitle: "Quanto custa transformar a ideia em um video original?",
    metric: "productionComplexity: 28/100",
    accent: "0xFACC15",
    background: "0x202124",
    duration: 4,
  },
  {
    id: "demo-04-revenue",
    title: "3. Faturamento",
    subtitle: "Nicho, seguranca para marcas, fit com patrocinadores e demanda.",
    metric: "revenuePotential: 82/100",
    accent: "0xA7F3D0",
    background: "0x14342B",
    duration: 4,
  },
  {
    id: "demo-05-verdict",
    title: "Veredito",
    subtitle: "Tendencia forte + producao simples + bom potencial comercial.",
    metric: "GREENLIGHT - finalScore: 78/100",
    accent: "0x34D399",
    background: "0x111827",
    duration: 5,
  },
];

export async function createDemoVideo(outputPath: string): Promise<EditPlan> {
  const ffmpegPath = assertFfmpegAvailable();
  const assetDir = resolve(process.cwd(), "data", "demo", "assets");
  await mkdir(assetDir, { recursive: true });

  const assets = [];
  for (const slide of slides) {
    const localPath = resolve(assetDir, `${slide.id}.mp4`);
    renderSlide(ffmpegPath, slide, localPath);
    assets.push({
      id: slide.id,
      localPath: relativeToCwd(localPath),
      licenseBasis: "owned" as const,
      start: "00:00:00",
      duration: `00:00:${String(slide.duration).padStart(2, "0")}`,
      editorialPurpose: `Synthetic owned slide used to demonstrate the ${slide.title} part of the scoring workflow.`,
      approvedBy: "ytfun-demo-generator",
    });
  }

  const manifest: RightsManifest = {
    projectTitle: "YTfun scoring demo",
    editor: "ytfun-demo-generator",
    assets,
  };

  await writeJsonFile("data/demo/rights-manifest.json", manifest);
  const plan = await compileManifest(manifest, outputPath);
  await writeJsonFile("data/demo/edit-plan.json", plan);
  return plan;
}

function renderSlide(ffmpegPath: string, slide: DemoSlide, outputPath: string): void {
  const filter = [
    `drawbox=x=0:y=0:w=1920:h=1080:color=${slide.background}:t=fill`,
    `drawbox=x=0:y=0:w=1920:h=18:color=${slide.accent}:t=fill`,
    `drawbox=x=150:y=758:w=1620:h=86:color=0x000000@0.28:t=fill`,
    drawText(slide.title, 150, 220, 74, "0xFFFFFF", true),
    drawText(slide.subtitle, 154, 345, 34, "0xE5E7EB", false),
    drawText(slide.metric, 190, 782, 38, slide.accent, false),
    drawText("original synthetic demo asset | no third-party footage", 150, 960, 24, "0xCBD5E1", false),
  ].join(",");

  const result = spawnSync(
    ffmpegPath,
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `color=c=${slide.background}:s=1920x1080:d=${slide.duration}:r=30`,
      "-f",
      "lavfi",
      "-i",
      `anullsrc=channel_layout=stereo:sample_rate=48000:d=${slide.duration}`,
      "-vf",
      filter,
      "-shortest",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-preset",
      "veryfast",
      "-crf",
      "20",
      "-c:a",
      "aac",
      "-ar",
      "48000",
      "-ac",
      "2",
      outputPath,
    ],
    { encoding: "utf8" },
  );

  if (result.status !== 0) {
    throw new Error(`Failed to render demo slide ${slide.id}:\n${result.stderr}`);
  }
}

function drawText(text: string, x: number, y: number, size: number, color: string, bold: boolean): string {
  const font = resolveFont(bold);
  return `drawtext=fontfile='${escapeFilterValue(font)}':text='${escapeFilterValue(text)}':x=${x}:y=${y}:fontsize=${size}:fontcolor=${color}:line_spacing=16`;
}

function resolveFont(bold: boolean): string {
  if (process.platform === "darwin") {
    return bold
      ? "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
      : "/System/Library/Fonts/Supplemental/Arial.ttf";
  }
  return bold ? "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" : "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
}

function escapeFilterValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll(":", "\\:").replaceAll("'", "\\'");
}

function relativeToCwd(path: string): string {
  return path.replace(`${resolve(process.cwd())}/`, "");
}
