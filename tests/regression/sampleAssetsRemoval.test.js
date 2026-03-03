import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';

import { chromium } from 'playwright';

import { calculateAlphaMap } from '../../src/core/alphaMap.js';
import { removeWatermark } from '../../src/core/blendModes.js';
import {
    computeRegionSpatialCorrelation,
    detectAdaptiveWatermarkRegion,
    interpolateAlphaMap,
    shouldAttemptAdaptiveFallback
} from '../../src/core/adaptiveDetector.js';
import {
    calculateWatermarkPosition,
    detectWatermarkConfig,
    resolveInitialStandardConfig
} from '../../src/core/watermarkConfig.js';

const ROOT_DIR = process.cwd();
const SAMPLE_DIR = path.resolve(ROOT_DIR, 'src/assets/samples');
const BG48_PATH = path.resolve(ROOT_DIR, 'src/assets/bg_48.png');
const BG96_PATH = path.resolve(ROOT_DIR, 'src/assets/bg_96.png');
const IMAGE_EXTENSIONS = new Set(['.png', '.webp', '.jpg', '.jpeg']);

function cloneImageData(imageData) {
    return {
        width: imageData.width,
        height: imageData.height,
        data: new Uint8ClampedArray(imageData.data)
    };
}

function inferMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.webp') return 'image/webp';
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
    return 'image/png';
}

async function decodeImageDataInPage(page, filePath) {
    const buffer = await readFile(filePath);
    const mime = inferMimeType(filePath);
    const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;

    const output = await page.evaluate(async (imageUrl) => {
        const img = new Image();
        img.src = imageUrl;
        await img.decode();

        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;

        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);

        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        return {
            width: imageData.width,
            height: imageData.height,
            data: imageData.data
        };
    }, dataUrl);

    return {
        width: output.width,
        height: output.height,
        data: new Uint8ClampedArray(output.data)
    };
}

function removeWatermarkLikeEngine(imageData, alpha48, alpha96) {
    const defaultConfig = detectWatermarkConfig(imageData.width, imageData.height);
    const resolvedConfig = resolveInitialStandardConfig({
        imageData,
        defaultConfig,
        alpha48,
        alpha96
    });

    let config = resolvedConfig;
    let position = calculateWatermarkPosition(imageData.width, imageData.height, config);
    let alphaMap = config.logoSize === 96 ? alpha96 : alpha48;

    const fixed = cloneImageData(imageData);
    removeWatermark(fixed, alphaMap, position);
    let finalImageData = fixed;

    const shouldFallback = shouldAttemptAdaptiveFallback({
        processedImageData: fixed,
        alphaMap,
        position,
        originalImageData: imageData,
        originalSpatialMismatchThreshold: 0
    });

    if (shouldFallback) {
        const adaptive = detectAdaptiveWatermarkRegion({
            imageData,
            alpha96,
            defaultConfig: config
        });

        if (adaptive.found) {
            const size = adaptive.region.size;
            const adaptivePosition = {
                x: adaptive.region.x,
                y: adaptive.region.y,
                width: size,
                height: size
            };
            const positionDelta =
                Math.abs(adaptivePosition.x - position.x) +
                Math.abs(adaptivePosition.y - position.y) +
                Math.abs(adaptivePosition.width - position.width);

            if (positionDelta >= 4) {
                position = adaptivePosition;
                alphaMap = size === 96 ? alpha96 : interpolateAlphaMap(alpha96, 96, size);
                finalImageData = cloneImageData(imageData);
                removeWatermark(finalImageData, alphaMap, position);
            }
        }
    }

    const beforeScore = computeRegionSpatialCorrelation({
        imageData,
        alphaMap,
        region: {
            x: position.x,
            y: position.y,
            size: position.width
        }
    });

    const afterScore = computeRegionSpatialCorrelation({
        imageData: finalImageData,
        alphaMap,
        region: {
            x: position.x,
            y: position.y,
            size: position.width
        }
    });

    return { beforeScore, afterScore, improvement: beforeScore - afterScore };
}

test('all sample assets should show strong watermark suppression after processing', async () => {
    const files = (await readdir(SAMPLE_DIR))
        .filter((name) => IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase()))
        .sort((a, b) => a.localeCompare(b));

    assert.ok(files.length > 0, 'samples directory should contain image files');

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    try {
        const alpha48 = calculateAlphaMap(await decodeImageDataInPage(page, BG48_PATH));
        const alpha96 = calculateAlphaMap(await decodeImageDataInPage(page, BG96_PATH));

        for (const fileName of files) {
            const filePath = path.join(SAMPLE_DIR, fileName);
            const imageData = await decodeImageDataInPage(page, filePath);
            const result = removeWatermarkLikeEngine(imageData, alpha48, alpha96);

            assert.ok(
                result.beforeScore >= 0.3,
                `${fileName}: expected watermark signal before processing >= 0.3, got ${result.beforeScore}`
            );
            assert.ok(
                result.afterScore < 0.22,
                `${fileName}: expected residual signal after processing < 0.22, got ${result.afterScore}`
            );
            assert.ok(
                result.improvement >= 0.35,
                `${fileName}: expected signal improvement >= 0.35, got ${result.improvement}`
            );
        }
    } finally {
        await browser.close();
    }
});
