// Butterchurn ships no types; this covers the part Beacon calls.
declare module 'butterchurn' {
  /** A converted Milkdrop preset - opaque to Beacon, handed through as-is. */
  export type MilkdropPreset = Record<string, unknown>

  /** One shader program's sources, exactly as Butterchurn builds them. */
  export interface ShaderSources {
    vert: string
    frag: string
  }

  /** A preset's two per-preset shaders. */
  export interface PresetShaders<T> {
    warp: T
    comp: T
  }

  export interface MilkdropVisualizer {
    connectAudio(node: AudioNode): void
    disconnectAudio(node: AudioNode): void
    /** Patched in (patches/butterchurn@2.6.7.patch): the warp and comp
     * shader sources the preset would compile, touching no GL state. */
    shaderSources(preset: MilkdropPreset): PresetShaders<ShaderSources>
    /** Blends from the current preset over `blendSeconds`. `linked`
     * (patched in) are programs already linked from shaderSources(), used
     * instead of compiling them again. */
    loadPreset(
      preset: MilkdropPreset,
      blendSeconds?: number,
      linked?: PresetShaders<WebGLProgram> | null,
    ): void
    setRendererSize(width: number, height: number, opts?: { pixelRatio?: number }): void
    /** Without `audioLevels` it reads the connected audio node itself. */
    render(opts?: {
      audioLevels?: {
        timeByteArray: Uint8Array
        timeByteArrayL: Uint8Array
        timeByteArrayR: Uint8Array
      }
    }): void
  }

  export interface Butterchurn {
    createVisualizer(
      context: BaseAudioContext,
      canvas: HTMLCanvasElement,
      opts: { width: number; height: number; pixelRatio?: number; textureRatio?: number },
    ): MilkdropVisualizer
  }

  // Typed as either shape on purpose - see services/milkdrop/butterchurn.ts.
  const butterchurn: Butterchurn | { default: Butterchurn }
  export default butterchurn
}
