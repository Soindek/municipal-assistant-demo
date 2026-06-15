import type {
  DocumentSource,
  DocumentSourceFactory,
  SourceDescriptor,
} from '@municipal-assistant/shared';
import { createDlpLibrarySource } from './sources/dlp-library.js';
import { createGoogleDriveSource } from './sources/google-drive.js';
import { createManualUploadSource } from './sources/manual-upload.js';
import { createNjtDecreesSource } from './sources/njt-decrees.js';
import { createWordpressAccordionSource } from './sources/wordpress-accordion.js';
import { createWordpressPagesSource } from './sources/wordpress-pages.js';

/**
 * Adapter registry: name → factory (BRIEF points 4/9). There is no plugin
 * system beyond this; a new adapter is added here with a single entry.
 */
const factories: Record<string, DocumentSourceFactory> = {
  'manual-upload': createManualUploadSource,
  'wordpress-accordion': createWordpressAccordionSource,
  'njt-decrees': createNjtDecreesSource,
  'dlp-library': createDlpLibrarySource,
  'google-drive': createGoogleDriveSource,
  'wordpress-pages': createWordpressPagesSource,
};

export function registerAdapter(name: string, factory: DocumentSourceFactory): void {
  factories[name] = factory;
}

/** Instantiates a DocumentSource based on the descriptor. */
export function createSource(descriptor: SourceDescriptor): DocumentSource {
  const factory = factories[descriptor.adapter];
  if (!factory) {
    const known = Object.keys(factories).join(', ');
    throw new Error(`Unknown adapter: "${descriptor.adapter}". Registered: ${known}`);
  }
  return factory(descriptor.options);
}

export function knownAdapters(): string[] {
  return Object.keys(factories);
}
