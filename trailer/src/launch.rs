//! The launch video: about thirty seconds, every shot from straight above as the game is
//! played, cut faster towards a police chase; three short lines; then the dark, the pull
//! back from the car on most Legií to every street lamp of the city (the maps and the
//! counting of `atmo.rs`), and the title.
//!
//! `launch/plan.py` holds the timing (`launch_data.rs` is made from it), `launch/shots.js`
//! the shots and `launch/soundtrack.py` the sound, the game's own from each shot.
use crate::atmo::{maps, settle, smooth, spaced, tally, CITY};
use crate::launch_data::*;
use crate::TrailerMedia;
use fframes::{
    AudioMap, AudioTimestamp::*, AudioTrack, Color, Duration, FFramesContext, Frame, Scene, Scenes, Svgr,
    SyncVideoFrameInput, Video,
};

const FPS: f32 = 30.0;
const PAPER: &str = "#f3ecdd";
const RED: &str = "#d8362d";
const AMBER: &str = "#ffc480";
const NIGHT: &str = "#090b10";
const TITLE_FONT: &str = "Bebas Neue";
const MONO: &str = "IBM Plex Mono";
const TEXT: &str = "DM Sans";

pub struct LaunchVideo<'a> {
    pub media: &'a TrailerMedia,
    whole: Whole,
}

impl<'a> LaunchVideo<'a> {
    /// `czech`: the lines, the numbers' labels and the title's line in Czech.
    pub fn new(media: &'a TrailerMedia, czech: bool) -> Self {
        Self { media, whole: Whole { czech } }
    }
}

impl std::fmt::Debug for LaunchVideo<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LaunchVideo").finish()
    }
}

impl Video for LaunchVideo<'_> {
    const FPS: usize = 30;
    const WIDTH: usize = crate::WIDTH;
    const HEIGHT: usize = crate::HEIGHT;
    const BACKGROUND_COLOR: Color = Color::BLACK;

    fn duration(&self) -> Duration<'_> {
        Duration::Auto
    }

    fn audio(&self) -> AudioMap<'_> {
        // One track, mixed by launch/soundtrack.py.
        AudioMap::from([AudioTrack::new("launch.wav", Second(0.)..Eof).fade_out(1.0)])
    }

    fn define_scenes(&self) -> Scenes<'_> {
        Scenes::from(vec![&self.whole as &dyn Scene])
    }

    fn render_frame<'a>(&'a self, frame: Frame, ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        fframes::svgr!(
            <svg xmlns="http://www.w3.org/2000/svg" width={crate::WIDTH} height={crate::HEIGHT} viewBox="0 0 1920 1080">
                <rect width="1920" height="1080" fill="#000000" />
                {ctx.render_scenes(&frame)}
            </svg>
        )
    }
}

#[derive(Debug)]
struct Whole {
    czech: bool,
}

/// A frame of a clip that began at frame `start` of the video, filling the picture
/// (scaled by `zoom` about its middle).
fn clip<'a>(frame: &Frame, ctx: &FFramesContext<'a, '_>, file: &'static str, start: usize, zoom: f32, opacity: f32) -> Svgr<'a> {
    use fframes::FFramesSyncedVideoFrame;
    let picture = frame
        .get_synced_video_frame(ctx, file, &SyncVideoFrameInput { start_from: start as f32 / FPS, looping: false, editor_fallback_image: None })
        .map(|v| v.into_image());
    let place = format!("translate({} {}) scale({zoom})", 960.0 * (1.0 - zoom), 540.0 * (1.0 - zoom));
    match picture {
        Some(image) => fframes::svgr!(<image href={image.href()} x="0" y="0" width="1920" height="1080" transform={place} opacity={opacity} />),
        None => fframes::svgr!(<g></g>),
    }
}

/// The time and the place of a shot, small in the top left corner.
fn caption<'a>(i: f32, n: f32, time: &'static str, place: &'static str) -> Svgr<'a> {
    let show = smooth(2.0, 9.0, i) * (1.0 - smooth(n - 4.0, n, i));
    let rule = 56.0 * settle((i - 2.0) / 12.0);
    fframes::svgr!(<g opacity={show} font-family={MONO} font-size="30" letter-spacing="6">
        <rect x="96" y="96" width={rule.max(0.5)} height="3" fill={RED} />
        <text x="98" y="146" fill="#000000" opacity="0.55">{time}</text>
        <text x="96" y="144" fill={PAPER}>{time}</text>
        <text x="240" y="146" fill="#000000" opacity="0.55">{place}</text>
        <text x="238" y="144" fill={PAPER} opacity="0.85">{place}</text>
    </g>)
}

impl Scene for Whole {
    fn duration(&self) -> Duration<'_> {
        Duration::Seconds(FRAMES as f32 / FPS)
    }

    fn render_frame<'a>(&'a self, frame: Frame, ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let f = frame.index.min(FRAMES - 1);
        let at = SEGMENTS.iter().rposition(|s| s.1 <= f).unwrap_or(0);
        let (kind, start, frames, file, time, place) = SEGMENTS[at];
        let (i, n) = ((f - start) as f32, frames as f32);

        // The line showing now, if any: it lands big and settles, and goes quickly.
        let line: Vec<Svgr> = LINES
            .iter()
            .filter(|l| f >= l.0 && f < l.1)
            .map(|&(a, b, en, cs)| {
                let (j, m) = ((f - a) as f32, (b - a) as f32);
                let show = smooth(0.0, 4.0, j) * (1.0 - smooth(m - 6.0, m, j));
                let grow = 1.0 + 0.18 * (1.0 - settle(j / 10.0));
                let text = if self.czech { cs } else { en };
                let rule = 220.0 * settle((j - 3.0) / 10.0);
                fframes::svgr!(<g opacity={show} transform={format!("translate({} {}) scale({grow})", 960.0 * (1.0 - grow), 600.0 * (1.0 - grow))}>
                    <text x="966" y="636" text-anchor="middle" font-family={TITLE_FONT} font-size="210" letter-spacing="10" fill="#000000" opacity="0.5">{text}</text>
                    <text x="960" y="630" text-anchor="middle" font-family={TITLE_FONT} font-size="210" letter-spacing="10" fill={PAPER}>{text}</text>
                    <rect x={960.0 - rule / 2.0} y="664" width={rule.max(0.5)} height="7" fill={RED} />
                </g>)
            })
            .collect();

        match kind {
            // A shot: each cut lands with a small push in that settles, and a flash.
            0 => {
                let zoom = 1.0 + 0.05 * (1.0 - settle(i / 8.0)) + 0.01 * i / n;
                let flash = if at > 0 { 0.28 * (1.0 - (i / 3.0).min(1.0)) } else { 0.0 };
                // The first comes up out of the black.
                let up = if at == 0 { smooth(0.0, 18.0, i) } else { 1.0 };
                fframes::svgr!(<g>
                    {clip(&frame, ctx, file, start, zoom, up)}
                    <rect width="1920" height="1080" fill="#ffffff" opacity={flash} />
                    {caption(i, n, time, place)}
                    {line}
                </g>)
            }
            // The dark.
            1 => fframes::svgr!(<g></g>),
            // The pull back, and the title over where it ends.
            _ => {
                let rise = SEGMENTS.iter().find(|s| s.0 == 2).copied().unwrap_or(SEGMENTS[0]);
                let r = f - rise.1;
                let seconds = r as f32 / FPS;
                let h = HEIGHT[r.min(HEIGHT.len() - 1)];
                // The middle slides from the car to the city's middle as the view widens.
                let slide = smooth(0.0, 1.0, (h / 2500.0).max(1.0).ln() / (30000.0f32 / 2500.0).ln());
                let c = (RISE_AT.0 + (CITY.0 - RISE_AT.0) * slide, RISE_AT.1 + (CITY.1 - RISE_AT.1) * slide);
                let titled = kind == 3;
                let t = if titled { i } else { -1.0 };
                let dim = if titled { 0.5 * smooth(0.0, 18.0, t) } else { 0.0 };
                let film = if r < FILMED { clip(&frame, ctx, rise.3, rise.1, 1.0, smooth(0.0, 8.0, r as f32)) } else { fframes::svgr!(<g></g>) };
                let numbers = 1.0 - smooth(rise.2 as f32 - 16.0, rise.2 as f32 - 2.0, r as f32);
                let cz = self.czech;
                fframes::svgr!(<g>
                    <rect width="1920" height="1080" fill={NIGHT} />
                    {film}
                    {maps(ctx, h, c, smooth(380.0, 820.0, h), dim, None)}
                    <g opacity={numbers}>
                        <text x="1824" y="146" text-anchor="end" font-family={MONO} font-size="26" letter-spacing="5" fill={PAPER} opacity={0.7 * smooth(0.3, 1.0, seconds)}>{format!("{} M", spaced(if h < 1000.0 { h } else { (h / 100.0).round() * 100.0 }))}</text>
                        {tally(seconds, 1.5, 0.0, LAMPS, if cz { "POULIČNÍCH LAMP" } else { "STREET LAMPS" })}
                        {tally(seconds, 2.1, 1.0, BUILDINGS, if cz { "BUDOV" } else { "BUILDINGS" })}
                        {tally(seconds, 2.7, 2.0, ROAD_KM, if cz { "KM ULIC" } else { "KM OF STREETS" })}
                        {tally(seconds, 3.3, 3.0, KM2, if cz { "KM² MAPY" } else { "KM² OF MAP" })}
                    </g>
                    <g opacity={if titled { smooth(2.0, 16.0, t) * (1.0 - smooth(n - 10.0, n - 1.0, t)) } else { 0.0 }}>
                        <text x="960" y={556.0 + 36.0 * (1.0 - settle(t / 24.0))} text-anchor="middle" font-family={TITLE_FONT} font-size="236" letter-spacing="10" fill={PAPER}>"STREETS OF PRAGUE"</text>
                        <rect x={960.0 - 270.0 * settle((t - 6.0) / 24.0)} y="604" width={(540.0 * settle((t - 6.0) / 24.0)).max(0.5)} height="7" fill={RED} />
                        <text x="960" y="690" text-anchor="middle" font-family={TEXT} font-size="42" letter-spacing="3" fill={PAPER} opacity={smooth(14.0, 32.0, t)}>{if cz { "Celá Praha. V prohlížeči." } else { "All of Prague. In your browser." }}</text>
                        <text x="960" y="776" text-anchor="middle" font-family={TITLE_FONT} font-size="70" letter-spacing="6" fill={AMBER} opacity={smooth(24.0, 42.0, t)}>"STREETSOFPRAGUE.COM"</text>
                    </g>
                </g>)
            }
        }
    }
}
