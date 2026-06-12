import type {
  DocumentSource,
  DocumentSourceFactory,
  SourceDescriptor,
} from '@municipal-assistant/shared';
import { createManualUploadSource } from './sources/manual-upload.js';
import { createWordpressAccordionSource } from './sources/wordpress-accordion.js';

/**
 * Adapter-regiszter: név → factory (BRIEF 4./9. pont). Nincs plugin-rendszer
 * ezen túl; új adapter ide egy bejegyzéssel kerül be.
 */
const factories: Record<string, DocumentSourceFactory> = {
  'manual-upload': createManualUploadSource,
  'wordpress-accordion': createWordpressAccordionSource,
};

export function registerAdapter(name: string, factory: DocumentSourceFactory): void {
  factories[name] = factory;
}

/** A descriptor alapján példányosít egy DocumentSource-t. */
export function createSource(descriptor: SourceDescriptor): DocumentSource {
  const factory = factories[descriptor.adapter];
  if (!factory) {
    const known = Object.keys(factories).join(', ');
    throw new Error(`Ismeretlen adapter: "${descriptor.adapter}". Regisztráltak: ${known}`);
  }
  return factory(descriptor.options);
}

export function knownAdapters(): string[] {
  return Object.keys(factories);
}
