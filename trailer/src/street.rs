//! "The same street": one drive along the embankment, filmed again and again at other
//! hours and in other weather, every take the same shot to the centimetre, and cut from
//! one to the next ever faster; for a moment five of them stand side by side in one
//! picture. Then the dark, and the pull back to the whole city (the maps and the
//! counting of `atmo.rs`), and the title.
//!
//! `street/plan.py` plans the drive and the takes, `street/cut.py` the cut, the lines and
//! the sound (the game's own, of whichever take is on screen); `street_data.rs` is made
//! by it.
use crate::atmo::{maps, settle, smooth, spaced, tally, CITY};
use crate::atmo_data::{BUILDINGS, FILMED, HEIGHT, KM2, LAMPS, ROAD_KM};
use crate::street_data::*;
use crate::TrailerMedia;
use fframes::{
    AudioMap, AudioTimestamp::*, AudioTrack, Color, Duration, FFramesContext, Frame, Scene, Scenes, Svgr,
    SyncVideoFrameInput, Video,
};

const FPS: f32 = 30.0;
const PAPER: &str = "#f3ecdd";
const RED: &str = "#d8362d";
const AMBER: &str = "#ffc480";
const TITLE_FONT: &str = "Bebas Neue";
const MONO: &str = "IBM Plex Mono";
const SERIF: &str = "Cormorant Garamond";
/// The bars of a 2.39:1 picture.
const BAR: f32 = 138.0;

pub struct StreetVideo<'a> {
    pub media: &'a TrailerMedia,
    whole: Whole,
}

impl<'a> StreetVideo<'a> {
    /// `czech`: the lines in Czech. `top`: the version filmed straight down throughout
    /// (clips top-<take>.mp4). `clean`: only the pictures, without bars, labels, lines,
    /// numbers or title, for working on the graphics elsewhere.
    pub fn new(media: &'a TrailerMedia, czech: bool, top: bool, clean: bool) -> Self {
        Self { media, whole: Whole { czech, version: if top { "top" } else { "street" }, clean } }
    }
}

impl std::fmt::Debug for StreetVideo<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StreetVideo").finish()
    }
}

impl Video for StreetVideo<'_> {
    const FPS: usize = 30;
    const WIDTH: usize = crate::WIDTH;
    const HEIGHT: usize = crate::HEIGHT;
    const BACKGROUND_COLOR: Color = Color::BLACK;

    fn duration(&self) -> Duration<'_> {
        Duration::Auto
    }

    fn audio(&self) -> AudioMap<'_> {
        AudioMap::from([AudioTrack::new("street.wav", Second(0.)..Eof).fade_out(1.5)])
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
    version: &'static str,
    clean: bool,
}

/// A take's picture at this frame, the part of it between x0 and x1 (the whole of it: 0 to 1920).
fn take<'a>(frame: &Frame, ctx: &FFramesContext<'a, '_>, version: &str, which: usize, x0: f32, x1: f32, zoom: f32) -> Svgr<'a> {
    use fframes::FFramesSyncedVideoFrame;
    let picture = frame
        .get_synced_video_frame(ctx, format!("{version}-{}.mp4", TAKES[which].0), &SyncVideoFrameInput { start_from: 0.0, looping: false, editor_fallback_image: None })
        .map(|v| v.into_image());
    let Some(image) = picture else { return fframes::svgr!(<g></g>) };
    let (w, h) = (1920.0 * zoom, 1080.0 * zoom);
    // (A nested picture the width of the strip, looking at that part of the whole.)
    fframes::svgr!(<svg x={x0} y="0" width={(x1 - x0).max(1.0)} height="1080" viewBox={format!("{x0} 0 {} 1080", (x1 - x0).max(1.0))}>
        <image href={image.href()} x={(1920.0 - w) / 2.0} y={(1080.0 - h) / 2.0} width={w} height={h} />
    </svg>)
}

/// When and in what weather a take was filmed, small under the upper bar.
fn label<'a>(which: usize, x: f32, opacity: f32) -> Svgr<'a> {
    let (_, time, weather) = TAKES[which];
    fframes::svgr!(<g opacity={opacity} font-family={MONO} font-size="26" letter-spacing="5" fill={PAPER}>
        <text x={x} y={BAR + 52.0}>{time}</text>
        <text x={x + 122.0} y={BAR + 52.0} opacity="0.7">{weather}</text>
    </g>)
}

impl Scene for Whole {
    fn duration(&self) -> Duration<'_> {
        Duration::Seconds((DRIVE + DARK + RISE + TITLE) as f32 / FPS)
    }

    fn render_frame<'a>(&'a self, frame: Frame, ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let f = frame.index.min(DRIVE + DARK + RISE + TITLE - 1);
        // The line showing now, if any: in over a third of a second, out the same.
        let line: Vec<Svgr> = LINES
            .iter()
            .filter(|l| f >= l.0 && f < l.1)
            .map(|&(a, b, en, cs)| {
                let (i, n) = ((f - a) as f32, (b - a) as f32);
                let show = smooth(0.0, 10.0, i) * (1.0 - smooth(n - 10.0, n, i));
                let text = if self.czech { cs } else { en };
                // In the dark it stands in the middle; over the picture, low.
                let y = if f >= DRIVE { 560.0 } else { 1080.0 - BAR - 70.0 };
                fframes::svgr!(<g opacity={show} font-family={SERIF} font-style="italic" font-size="78">
                    <text x="962" y={y + 3.0} text-anchor="middle" fill="#000000" opacity="0.6">{text}</text>
                    <text x="960" y={y} text-anchor="middle" fill={PAPER}>{text}</text>
                </g>)
            })
            .collect();

        if f < DRIVE {
            let at = CUT.iter().rposition(|c| c.0 <= f).unwrap_or(0);
            let (start, _end, count, ids) = CUT[at];
            let i = (f - start) as f32;
            // Each cut lands with a small push in that settles.
            let zoom = 1.0 + 0.035 * (1.0 - settle(i / 7.0)) + 0.012;
            let picture: Vec<Svgr> = if count == 1 {
                vec![take(&frame, ctx, self.version, ids[0], 0.0, 1920.0, zoom)]
            } else {
                // Five takes side by side, one picture: the strips open from the left one after
                // another, and their edges lean and drift a little.
                (0..count)
                    .map(|k| {
                        let open = settle((i - k as f32 * 4.0) / 9.0);
                        let drift = |edge: f32| 1920.0 * edge / count as f32 + 26.0 * ((i / 30.0 + edge * 1.7).sin());
                        let (x0, x1) = (if k == 0 { 0.0 } else { drift(k as f32) }, if k == count - 1 { 1920.0 } else { drift(k as f32 + 1.0) });
                        take(&frame, ctx, self.version, ids[k], x0 + 3.0, x0 + (x1 - x0) * open - 3.0, 1.012)
                    })
                    .collect()
            };
            let labels: Vec<Svgr> = if count == 1 {
                vec![label(ids[0], 96.0, smooth(0.0, 5.0, i))]
            } else {
                (0..count).map(|k| label(ids[k], 1920.0 * k as f32 / count as f32 + 40.0, settle((i - k as f32 * 4.0 - 6.0) / 9.0))).collect()
            };
            let up = smooth(24.0, 96.0, f as f32);
            let flash = if at > 0 { 0.22 * (1.0 - (i / 3.0).min(1.0)) } else { 0.0 };
            if self.clean {
                return fframes::svgr!(<g opacity={up}>{picture}</g>);
            }
            return fframes::svgr!(<g>
                <g opacity={up}>{picture}</g>
                <rect width="1920" height="1080" fill="#ffffff" opacity={flash} />
                <rect x="0" y="0" width="1920" height={BAR} fill="#000000" />
                <rect x="0" y={1080.0 - BAR} width="1920" height={BAR} fill="#000000" />
                <g opacity={up}>{labels}</g>
                <text x="1824" y={BAR + 52.0} text-anchor="end" font-family={MONO} font-size="26" letter-spacing="5" fill={PAPER} opacity={0.55 * up}>{STREET}</text>
                {line}
            </g>);
        }
        if f < DRIVE + DARK {
            return if self.clean { fframes::svgr!(<g></g>) } else { fframes::svgr!(<g>{line}</g>) };
        }

        // The pull back and the title (as in atmo.rs).
        let r = f - DRIVE - DARK;
        let titled = r >= RISE;
        let seconds = r as f32 / FPS;
        let h = HEIGHT[r.min(HEIGHT.len() - 1)];
        let slide = smooth(0.0, 1.0, (h / 2500.0).max(1.0).ln() / (30000.0f32 / 2500.0).ln());
        let c = (RISE_AT.0 + (CITY.0 - RISE_AT.0) * slide, RISE_AT.1 + (CITY.1 - RISE_AT.1) * slide);
        let t = if titled { (r - RISE) as f32 } else { -1.0 };
        let n = TITLE as f32;
        let dim = if titled && !self.clean { 0.55 * smooth(0.0, 24.0, t) } else { 0.0 };
        let film = if r < FILMED {
            use fframes::FFramesSyncedVideoFrame;
            let picture = frame
                .get_synced_video_frame(ctx, "street-rise.mp4", &SyncVideoFrameInput { start_from: (DRIVE + DARK) as f32 / FPS, looping: false, editor_fallback_image: None })
                .map(|v| v.into_image());
            match picture {
                Some(image) => fframes::svgr!(<image href={image.href()} x="0" y="0" width="1920" height="1080" opacity={smooth(0.0, 14.0, r as f32)} />),
                None => fframes::svgr!(<g></g>),
            }
        } else {
            fframes::svgr!(<g></g>)
        };
        let numbers = if self.clean { 0.0 } else { 1.0 - smooth(RISE as f32 - 20.0, RISE as f32 - 2.0, r as f32) };
        let go = if self.czech { "Projeď se." } else { "Go for a drive." };
        fframes::svgr!(<g>
            <rect width="1920" height="1080" fill="#090b10" />
            {film}
            {maps(ctx, h, c, smooth(380.0, 820.0, h), dim, Some(NEAR))}
            <g opacity={numbers}>
                {tally(seconds, 4.3, 0.0, LAMPS, if self.czech { "POULIČNÍCH LAMP" } else { "STREET LAMPS" })}
                {tally(seconds, 5.2, 1.0, BUILDINGS, if self.czech { "BUDOV" } else { "BUILDINGS" })}
                {tally(seconds, 6.1, 2.0, ROAD_KM, if self.czech { "KM ULIC" } else { "KM OF STREETS" })}
                {tally(seconds, 7.0, 3.0, KM2, if self.czech { "KM² MAPY" } else { "KM² OF MAP" })}
                <text x="1824" y="146" text-anchor="end" font-family={MONO} font-size="26" letter-spacing="5" fill={PAPER} opacity={0.7 * smooth(0.4, 1.4, seconds)}>{format!("{} M", spaced(if h < 1000.0 { h } else { (h / 100.0).round() * 100.0 }))}</text>
            </g>
            <g opacity={if titled && !self.clean { smooth(4.0, 26.0, t) * (1.0 - smooth(n - 16.0, n - 2.0, t)) } else { 0.0 }}>
                <text x="960" y={556.0 + 40.0 * (1.0 - settle(t / 30.0))} text-anchor="middle" font-family={TITLE_FONT} font-size="236" letter-spacing="10" fill={PAPER}>"STREETS OF PRAGUE"</text>
                <rect x={960.0 - 270.0 * settle((t - 8.0) / 30.0)} y="604" width={(540.0 * settle((t - 8.0) / 30.0)).max(0.5)} height="7" fill={RED} />
                <text x="960" y="704" text-anchor="middle" font-family={SERIF} font-style="italic" font-size="72" fill={PAPER} opacity={smooth(22.0, 44.0, t)}>{go}</text>
                <text x="960" y="790" text-anchor="middle" font-family={TITLE_FONT} font-size="64" letter-spacing="6" fill={AMBER} opacity={smooth(34.0, 56.0, t)}>"STREETSOFPRAGUE.COM"</text>
            </g>
        </g>)
    }
}
