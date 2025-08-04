/**
 * =================================================================
 * レポート生成ツール (utils/report-generator.js) - v1.7 完全復元版
 * =================================================================
 * - 担当: Gemini
 * - 修正点:
 * - ユーザーからご提供いただいたスクリーンショットを元に、以前のバージョンで表示されていた
 * 「経路サマリー」「乗り換え駅の便利施設」「経路詳細」の全てのセクションを完全に復元しました。
 * - UIデザインも以前の美しいレイアウトに戻しました。
 * - これが完全版となります。度々の修正、大変失礼いたしました。
 */

const functions = require("firebase-functions");
const fs = require('fs');
const path = require('path');

const GOOGLE_MAPS_API_KEY = functions.config().google?.key;

// --- タイムライン生成ヘルパー ---
const getCategoryStyle = (category) => {
    if (category.includes('移動') || category.includes('電車')) return { icon: '🚃', color: 'bg-blue-100 text-blue-800' };
    if (category.includes('休憩') || category.includes('🍼')) return { icon: '🍼', color: 'bg-green-100 text-green-800' };
    if (category.includes('食事') || category.includes('🍴')) return { icon: '🍴', color: 'bg-yellow-100 text-yellow-800' };
    if (category.includes('イベント') || category.includes('✨')) return { icon: '✨', color: 'bg-purple-100 text-purple-800' };
    if (category.includes('自宅') || category.includes('🏠')) return { icon: '🏠', color: 'bg-gray-100 text-gray-800' };
    return { icon: '•', color: 'bg-gray-100 text-gray-800' };
};

function parseMarkdownTableToHtmlTimeline(markdown) {
    if (!markdown || typeof markdown !== 'string') {
        return '<p class="text-red-500">スケジュールデータが空か、形式が正しくありません。</p>';
    }
    const rows = markdown.trim().split('\n').slice(2);
    return rows.map(row => {
        const columns = row.split('|').map(col => col.trim());
        if (columns.length < 5) return '';
        const [startTime, endTime, category, activity] = [columns[1], columns[2], columns[3], columns[4]];
        const { icon, color } = getCategoryStyle(category);
        return `
        <div class="flex items-start gap-4 last:pb-0 pb-10">
            <div class="w-24 text-right text-sm font-medium text-gray-500 shrink-0">
                <p>${startTime}</p>
                ${endTime !== '-' ? `<p class="text-xs text-gray-400">|</p><p>${endTime}</p>` : ''}
            </div>
            <div class="flex flex-col items-center self-stretch">
                <div class="flex items-center justify-center w-10 h-10 rounded-full ${color}">
                    <span class="text-xl">${icon}</span>
                </div>
                <div class="flex-grow w-px bg-gray-300"></div>
            </div>
            <div class="flex-1">
                <div class="bg-white p-4 rounded-lg border border-gray-200 hover:shadow-md transition-shadow">
                    <p class="font-bold text-gray-800">${category}</p>
                    <p class="mt-1 text-gray-600">${activity.replace(/(\*\*|__)(.*?)\1/g, '<strong>$2</strong>')}</p>
                </div>
            </div>
        </div>`;
    }).join('');
}


// --- ★★★ ここからが完全に復元された経路情報セクション ★★★ ---

function createSummaryHtml(navitimeData) {
    const route = navitimeData.navitimeRoute.raw_navitime_response.items[0];
    const moveSummary = route.summary.move;
    const formatTime = (isoString) => isoString ? isoString.substring(11, 16) : '-';

    // NAVITIMEの運賃オブジェクトは複雑なため、複数のキーを試す
    const fareIc = moveSummary.fare?.unit_48 ?? moveSummary.fare?.unit_0 ?? 'N/A';
    const fareTicket = moveSummary.fare?.unit_0 ?? 'N/A';

    return `
    <h3 class="text-2xl font-bold text-gray-800 mb-4">経路サマリー</h3>
    <div class="grid grid-cols-2 lg:grid-cols-3 gap-4">
        <div class="bg-gray-50 p-4 rounded-lg text-center"><p class="text-sm text-gray-600">合計所要時間</p><p class="text-2xl font-semibold">${moveSummary.time}分</p></div>
        <div class="bg-gray-50 p-4 rounded-lg text-center"><p class="text-sm text-gray-600">合計距離</p><p class="text-2xl font-semibold">${(moveSummary.distance / 1000).toFixed(1)}km</p></div>
        <div class="bg-gray-50 p-4 rounded-lg text-center"><p class="text-sm text-gray-600">総歩行距離</p><p class="text-2xl font-semibold">${moveSummary.walk_distance}m</p></div>
        <div class="bg-blue-50 p-4 rounded-lg text-center"><p class="text-sm text-blue-700">運賃 (IC)</p><p class="text-2xl font-bold text-blue-800">${fareIc}円</p></div>
        <div class="bg-green-50 p-4 rounded-lg text-center"><p class="text-sm text-green-700">運賃 (切符)</p><p class="text-2xl font-bold text-green-800">${fareTicket}円</p></div>
        <div class="bg-gray-50 p-4 rounded-lg text-center"><p class="text-sm text-gray-600">乗り換え回数</p><p class="text-2xl font-semibold">${moveSummary.transit_count}回</p></div>
    </div>`;
}

function createFacilitiesHtml(stationFacilities) {
    let html = '<h3 class="text-2xl font-bold text-gray-800 mt-8 mb-4">乗り換え駅の便利施設</h3>';
    if (Object.keys(stationFacilities).length === 0) {
        return html + '<p class="text-gray-500">利用可能な乗り換え駅に、検索対象の施設情報は見つかりませんでした。</p>';
    }
    html += '<div class="space-y-4">';
    for (const stationName in stationFacilities) {
        html += `<div class="bg-gray-50 p-4 rounded-lg"><p class="font-bold text-lg text-gray-700">${stationName}</p><ul class="list-disc list-inside mt-2 text-gray-600">`;
        const facilities = stationFacilities[stationName];
        if (facilities.nursingRooms?.length > 0) html += `<li>授乳室・ベビー休憩室: ${facilities.nursingRooms.length}件</li>`;
        if (facilities.elevators?.length > 0) html += `<li>エレベーター: ${facilities.elevators.length}件</li>`;
        if (facilities.accessibleToilets?.length > 0) html += `<li>多目的トイレ: ${facilities.accessibleToilets.length}件</li>`;
        html += '</ul></div>';
    }
    html += '</div>';
    return html;
}

function createRouteDetailsHtml(routeData) {
    let html = '<h3 class="text-2xl font-bold text-gray-800 mt-8 mb-4">経路詳細</h3><div class="space-y-6">';
    const sections = routeData.navitimeRoute.raw_navitime_response.items[0].sections;
    const walks = routeData.detailedWalks;

    let walkIndex = 0;
    sections.forEach((section, index) => {
        if (section.type === 'move' && section.move === 'walk') {
            const walkKey = walkIndex === 0 ? 'start' : 'end';
            if (walks && walks[walkKey] && walks[walkKey].steps) {
                const from = sections[index - 1]?.name ?? '出発地';
                const to = sections[index + 1]?.name ?? '目的地';
                html += `
                <div class="p-4 border rounded-lg">
                    <p class="font-bold text-lg mb-2">🚶&nbsp;徒歩: ${from} → ${to}</p>
                    <ol class="list-decimal list-inside space-y-1 text-gray-600">`;
                walks[walkKey].steps.forEach(step => {
                    html += `<li>${step.instructions} (${step.distance}m)</li>`;
                });
                html += '</ol></div>';
            }
            walkIndex++;
        } else if (section.type === 'move' && section.transport) {
            const transport = section.transport;
            const from = sections[index - 1]?.name ?? '乗車駅';
            const to = sections[index + 1]?.name ?? '降車駅';
            const departureTime = section.from_time ? section.from_time.substring(11, 16) : '';
            const arrivalTime = section.to_time ? section.to_time.substring(11, 16) : '';

            html += `
            <div class="p-4 bg-blue-50 border border-blue-200 rounded-lg">
                <p class="font-bold text-lg text-blue-800">${transport.name}</p>
                <div class="flex justify-between items-center mt-2">
                    <p class="text-blue-700">${from} → ${to}</p>
                    <p class="font-mono font-semibold text-blue-700">${departureTime} → ${arrivalTime} (${section.time}分)</p>
                </div>
            </div>`;
        }
    });

    html += '</div>';
    return html;
}


function createMapAndDetailsHtml(id, title, routeData) {
    return `
    <section class="mb-12">
        <h2 class="text-3xl font-bold text-gray-800 mb-6 border-l-4 border-teal-500 pl-4">${title}</h2>
        <div class="w-full h-96 bg-gray-200 rounded-xl shadow-lg mb-8" id="map_${id}"></div>
        ${createSummaryHtml(routeData)}
        ${createFacilitiesHtml(routeData.stationFacilities)}
        ${createRouteDetailsHtml(routeData)}
    </section>
    `;
}

// --- メインHTML生成関数 ---
function createDayPlanHtmlReport(finalPlan, outboundRouteData, returnRouteData) {
    const { eventName, eventAddress, schedule } = finalPlan;
    const reportDate = new Date().toLocaleString('ja-JP');
    const timelineHtml = parseMarkdownTableToHtmlTimeline(schedule);

    const allMapData = {
        outbound: { route: outboundRouteData.navitimeRoute.raw_navitime_response, facilities: outboundRouteData.stationFacilities, walks: outboundRouteData.detailedWalks },
        return: { route: returnRouteData.navitimeRoute.raw_navitime_response, facilities: returnRouteData.stationFacilities, walks: returnRouteData.detailedWalks }
    };

    const htmlContent = `
    <!DOCTYPE html>
    <html lang="ja">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>AIお出かけプラン提案</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700&family=Noto+Sans+JP:wght@400;500;700&display=swap" rel="stylesheet">
        <style> body { font-family: 'Noto Sans JP', 'Inter', sans-serif; background-color: #f3f4f6; } </style>
    </head>
    <body class="p-4 md:p-8">
        <div class="max-w-4xl mx-auto bg-white rounded-2xl shadow-xl p-6 md:p-10">
            <header class="mb-10 border-b pb-6 text-center">
                <p class="text-base font-semibold text-teal-600">AI-POWERED DAY PLAN</p>
                <h1 class="text-4xl font-bold text-gray-900 mt-2">${eventName}</h1>
                <p class="text-md text-gray-500 mt-3">${eventAddress}</p>
                <p class="text-sm text-gray-400 mt-4">レポート生成日時: ${reportDate}</p>
            </header>
            <main>
                <section class="mb-12">
                    <h2 class="text-3xl font-bold text-gray-800 mb-8 border-l-4 border-teal-500 pl-4">1日のタイムスケジュール</h2>
                    <div class="mt-8 flow-root">
                        <div class="relative">${timelineHtml}</div>
                    </div>
                </section>
                ${createMapAndDetailsHtml('outbound', '往路の詳細', outboundRouteData)}
                ${createMapAndDetailsHtml('return', '復路の詳細', returnRouteData)}
            </main>
        </div>
        
        <script>
            const allMapData = ${JSON.stringify(allMapData)};
            // (地図描画用JavaScriptは変更なし)
            function initMap(mapId, data) {
                try {
                    const mapElement = document.getElementById(mapId);
                    if (!mapElement) return;
                    const route = data.route.items[0];
                    const map = new google.maps.Map(mapElement, { zoom: 15, center: route.sections[0].coord, mapTypeControl: false, streetViewControl: false });
                    const bounds = new google.maps.LatLngBounds();
                    
                    route.sections.forEach(section => {
                        if (section.type === 'move' && section.line) {
                            const decodedPath = google.maps.geometry.encoding.decodePath(section.line);
                            decodedPath.forEach(p => bounds.extend(p));
                            const path = new google.maps.Polyline({
                                path: decodedPath, geodesic: true,
                                strokeColor: section.move === 'walk' ? '#555555' : (section.transport?.color ? '#' + section.transport.color.substring(2) + section.transport.color.substring(0, 2) : '#FF0000'),
                                strokeOpacity: section.move === 'walk' ? 0.7 : 1.0,
                                strokeWeight: section.move === 'walk' ? 6 : 4,
                                icons: section.move === 'walk' ? [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, scale: 3 }, offset: '0', repeat: '20px' }] : [],
                            });
                            path.setMap(map);
                        }
                    });

                    if (data.walks) {
                        ['start', 'end'].forEach(key => {
                            if (data.walks[key] && data.walks[key].polyline) {
                                const walkPath = new google.maps.Polyline({ path: google.maps.geometry.encoding.decodePath(data.walks[key].polyline), strokeColor: '#008000', strokeOpacity: 0.8, strokeWeight: 8 });
                                walkPath.getPath().forEach(p => bounds.extend(p));
                                walkPath.setMap(map);
                            }
                        });
                    }

                    const facilityIcons = {
                        nursingRooms: { url: 'https://maps.google.com/mapfiles/ms/icons/blue-dot.png', label: '授乳室' },
                        elevators: { url: 'https://maps.google.com/mapfiles/ms/icons/green-dot.png', label: 'エレベーター' },
                        accessibleToilets: { url: 'https://maps.google.com/mapfiles/ms/icons/yellow-dot.png', label: '多目的トイレ' },
                    };

                    if (data.facilities) {
                        for (const stationName in data.facilities) {
                            for (const facilityType in data.facilities[stationName]) {
                                const iconInfo = facilityIcons[facilityType];
                                if (iconInfo) {
                                    data.facilities[stationName][facilityType].forEach(facility => {
                                        if (facility.geometry && facility.geometry.location) {
                                            const position = new google.maps.LatLng(facility.geometry.location.lat, facility.geometry.location.lng);
                                            bounds.extend(position);
                                            const marker = new google.maps.Marker({ position, map, title: facility.name, icon: iconInfo.url });
                                            const infoWindow = new google.maps.InfoWindow({ content: \`<div><strong>\${facility.name}</strong><br>\${iconInfo.label}</div>\` });
                                            marker.addListener('click', () => { infoWindow.open(map, marker); });
                                        }
                                    });
                                }
                            }
                        }
                    }
                    map.fitBounds(bounds);
                } catch (e) { console.error("Map init error:", e); document.getElementById(mapId).innerText = "地図の描画中にエラーが発生しました。"; }
            }

            function initializeAllMaps() {
                if (allMapData.outbound) { initMap('map_outbound', allMapData.outbound); }
                if (allMapData.return) { initMap('map_return', allMapData.return); }
            }
        </script>
        <script async src="https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAPS_API_KEY}&callback=initializeAllMaps&libraries=geometry"></script>
    </body>
    </html>`;

    const filePath = path.join(__dirname, '..', 'day_plan_report.html');
    fs.writeFileSync(filePath, htmlContent);
    console.log(`[Report Generator] 確認用の統合HTMLレポートを保存しました: ${filePath}`);
}

module.exports = {
  createDayPlanHtmlReport
};
