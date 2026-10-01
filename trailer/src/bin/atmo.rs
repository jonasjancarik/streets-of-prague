use fframes::{CombinedMediaProvider, EncoderOptions, MediaDirectory, MediaProvider, RenderOptions, StaticMediaProvider, cli};
use fframes_skia_renderer::{
    SkiaFFramesRenderer, SkiaPipelineConcurrencyPolicy, SkiaPipelineConfig,
    metal::SkiaMetalCtx,
};
use trailer::{atmo::AtmoVideo, TrailerMedia, HEIGHT, WIDTH};
use fframes::cli::clap; // the derive below expands to `clap::...`
use std::process::ExitCode;

/// No flags of its own: the standard ones of `fframes::cli` (render, frame, strip, inspect, audio, ...).
#[derive(Debug, clap::Args)]
struct VideoArgs {}

fn main() -> ExitCode {
    let args = cli::parse::<VideoArgs>();
    let media = TrailerMedia::prepare().expect("media");
    // The filmed clips, next to the sources (record.sh puts them there).
    let clips_dir = MediaDirectory::read_folder(concat!(env!("CARGO_MANIFEST_DIR"), "/clips")).expect("the clips folder: run trailer/record.sh first");
    let clips = clips_dir.process_media_source().expect("clips");
    let all_media = CombinedMediaProvider::from([&media as &dyn MediaProvider, &clips as &dyn MediaProvider]);

    let video = AtmoVideo::new(&media);
    let gpu = SkiaMetalCtx::new(WIDTH, HEIGHT).expect("GPU context");

    cli::new(
        &video,
        RenderOptions {
            media: Some(&all_media),
            video_encoder_options: EncoderOptions {
                preferred_encoder: Some("libx264"),
                codec_params: Some(&[("crf", "20"), ("preset", "medium"), ("tune", "film")]),
                ..Default::default()
            },
            ..Default::default()
        },
    )
    .args(args)
    // Frame previews (frame, strip, onion, snapshot) render with the same Skia backend.
    .backend(
        SkiaFFramesRenderer::new_metal(
            &gpu,
            SkiaPipelineConfig {
                concurrency_policy: SkiaPipelineConcurrencyPolicy::MaxPerformance,
                ..Default::default()
            },
        )
        .expect("skia renderer"),
    )
    // `preview` opens the real-time GPU player.
    .preview(fframes_native_player::cli_preview)
    .run()
}
