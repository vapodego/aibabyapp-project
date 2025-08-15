/**
 * =================================================================
 * Day Planner用 HTML生成モジュール (最終FIX版)
 * =================================================================
 */
const functions = require("firebase-functions");

function generateDayPlanHtmlResponse(plan) {
    const GOOGLE_API_KEY = functions.config().google?.key;
    
    const decodePolyline = (encoded) => {
        if (!encoded) return [];
        let index = 0, len = encoded.length, lat = 0, lng = 0, array = [];
        while (index < len) {
            let b, shift = 0, result = 0;
            do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
            let dlat = ((result & 1) ? ~(result >> 1) : (result >> 1)); lat += dlat;
            shift = 0; result = 0;
            do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
            let dlng = ((result & 1) ? ~(result >> 1) : (result >> 1)); lng += dlng;
            array.push({ lat: lat / 1e5, lng: lng / 1e5 });
        }
        return array;
    };

    const decodedCoords = decodePolyline(plan.map_polyline);
    
    const parseScheduleForCard = (scheduleText) => {
        if (!scheduleText || typeof scheduleText !== 'string') return [];
        const lines = scheduleText.split('\n').filter(line => line.startsWith('|') && !line.includes('---') && line.trim().length > 2);
        return lines.map(line => {
            const parts = line.split('|').map(s => s.trim()).filter(Boolean);
            return parts.length >= 2 ? { time: parts[0], activity: parts[1], details: parts[2] || '' } : null;
        }).filter(Boolean);
    };

    const hourlyWeatherMap = new Map();
    if (plan.weather?.hourly) {
        plan.weather.hourly.forEach(h => hourlyWeatherMap.set(new Date(h.time).getHours(), { icon: h.icon, temp: Math.round(h.temp) }));
    }

    let scheduleCardHtml = '<p>スケジュール情報がありません。</p>';
    if (plan.schedule) {
        const scheduleItems = parseScheduleForCard(plan.schedule);
        if (scheduleItems.length > 0) {
            scheduleCardHtml = `<div class="flow-root">${scheduleItems.map(item => {
                const scheduleHour = parseInt(item.time.substring(0, 2), 10);
                const weatherForHour = hourlyWeatherMap.get(scheduleHour);
                return `
                    <div class="flex items-center py-3 border-b border-gray-100 last:border-b-0">
                        <div class="w-24 shrink-0"><span class="font-bold text-gray-800">${item.time}</span></div>
                        <div class="flex-1 pl-4">
                            <p class="font-semibold text-gray-700">${item.activity} ${weatherForHour ? `<span class="ml-2 text-sm">${weatherForHour.icon}${weatherForHour.temp}°C</span>` : ''}</p>
                            ${item.details ? `<p class="text-sm text-gray-500 mt-1">${item.details}</p>`: ''}
                        </div>
                        ${item.activity.includes('出発') ? `<button onclick="showRouteModal()" class="ml-4 bg-blue-500 text-white text-xs font-bold py-1 px-3 rounded-full hover:bg-blue-600">経路</button>` : ''}
                    </div>`;
            }).join('')}</div>`;
        }
    }

    const directionsHtml = plan.directions?.steps?.map(step => `
        <div class="flex items-start py-3 border-b"><div class="text-2xl mr-3 pt-1">➡️</div><div class="flex-1">
            <div class="text-sm">${step.html_instructions}</div><div class="text-xs text-gray-500 mt-1">${step.duration.text} (${step.distance.text})</div>
        </div></div>`).join('') || '<p>詳細な経路情報はありません。</p>';
    
    // ★★★ 育児情報の表示ロジックを更新 ★★★
    let babyInfoHtml = `<p class="pl-10 text-gray-400">${plan.babyInfo?.notes || '（育児設備の情報は見つかりませんでした）'}</p>`;
    if (plan.babyInfo && plan.babyInfo.data) {
        const facilities = [
            { key: 'nursing_room', label: '授乳室' },
            { key: 'diaper_station', label: 'おむつ交換台' },
            { key: 'hot_water', label: '調乳器（給湯器）' },
            { key: 'stroller_rental', label: 'ベビーカーレンタル' }
        ];

        const tableRows = facilities.map(item => {
            const details = plan.babyInfo.data[item.key];
            const status = details ? `<span class="text-green-600 font-semibold">✔</span> ${details}` : '<span class="text-red-500 font-semibold">✖</span> 確認できませんでした';
            return `<tr>
                <td class="px-4 py-2 border-t font-semibold">${item.label}</td>
                <td class="px-4 py-2 border-t">${status}</td>
            </tr>`;
        }).join('');
        
        const sourceLink = plan.babyInfo.sourceUrl 
            ? `<div class="text-xs text-right mt-2">情報参照元: <a href="${plan.babyInfo.sourceUrl}" target="_blank" class="text-blue-500 hover:underline">公式サイト等</a></div>` 
            : '';

        babyInfoHtml = `
            <div class="pl-10">
                <table class="table-auto w-full text-sm">
                    <thead>
                        <tr>
                            <th class="px-4 py-2 text-left bg-gray-50 w-1/3">設備</th>
                            <th class="px-4 py-2 text-left bg-gray-50">有無・場所詳細</th>
                        </tr>
                    </thead>
                    <tbody>${tableRows}</tbody>
                </table>
                ${sourceLink}
            </div>
        `;
    }

    let activitiesHtml = '';
    if (plan.activities && plan.activities.length > 0) {
        const activityItems = plan.activities.map(activity => `<li class="flex items-start"><span class="text-emerald-500 mr-2">✔</span><span>${activity}</span></li>`).join('');
        activitiesHtml = `
            <div class="section-header mt-8">
                <span class="text-2xl">🎉</span><h2 class="section-title">主なアクティビティ</h2>
            </div>
            <div class="pl-10"><ul class="space-y-2 text-gray-600">${activityItems}</ul></div>
        `;
    }

    return `
    <!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Day Planner 実行結果</title><script src="https://cdn.tailwindcss.com"></script>
    <script src="https://maps.googleapis.com/maps/api/js?key=${GOOGLE_API_KEY}&callback=initMap" async defer></script>
    <style>.content-card{background-color:white;border-radius:0.75rem;box-shadow:0 4px 6px -1px #0000001a, 0 2px 4px -2px #0000001a;padding:1.5rem;margin-bottom:2rem;}.section-header{display:flex;align-items:center;margin-bottom:1rem;padding-bottom:0.5rem;border-bottom:1px solid #f3f4f6;}.section-title{font-size:1.125rem;font-weight:700;color:#374151;margin-left:0.75rem;}.modal-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background-color:rgba(0,0,0,0.5);z-index:40;display:none;}.modal-content{position:fixed;bottom:0;left:0;right:0;max-height:75%;background-color:white;z-index:50;transform:translateY(100%);transition:transform 0.3s ease-in-out;}.modal-open .modal-content{transform:translateY(0);}</style>
    </head><body class="bg-gray-50"><div class="container mx-auto p-4 md:p-8 max-w-4xl">
        <div class="content-card"><h1 class="text-3xl font-extrabold text-gray-900 text-center mb-4">${plan.planName || 'イベントプラン'}</h1>
            <div class="border rounded-lg overflow-hidden mb-4"><table class="w-full text-sm"><tbody>
                <tr><td class="px-4 py-3 bg-gray-50 font-semibold w-1/4">イベント名</td><td class="px-4 py-3">${plan.eventName || '情報なし'}</td></tr>
                <tr><td class="px-4 py-3 bg-gray-50 font-semibold border-t">開催期間</td><td class="px-4 py-3 border-t">${plan.eventDateString || '要確認'}</td></tr>
                <tr><td class="px-4 py-3 bg-gray-50 font-semibold border-t">天気予報 (${plan.userTripDate})</td><td class="px-4 py-3 border-t">${plan.weather?.daily ? `${plan.weather.daily.icon} ${plan.weather.daily.forecast}` : '当日のお楽しみ'}</td></tr>
                <tr><td class="px-4 py-3 bg-gray-50 font-semibold border-t">場所</td><td class="px-4 py-3 border-t">${plan.eventAddress || plan.venueName || '情報なし'}</td></tr>
            </tbody></table></div>
            <div class="text-center mb-6"><a href="${plan.eventUrl || '#'}" target="_blank" class="text-blue-500 hover:underline">公式サイトで詳細を見る →</a></div>
            <div class="text-base text-gray-700 leading-relaxed mb-8 bg-amber-50 p-4 rounded-lg">${plan.overview || ''}</div>
            ${activitiesHtml}
            <div class="section-header mt-8"><span class="text-2xl">👶</span><h2 class="section-title">赤ちゃん向け設備</h2></div>${babyInfoHtml}
        </div>
        <div class="content-card">
            <div class="section-header"><span class="text-2xl">✨</span><h2 class="section-title">戦略ガイド</h2></div>
            <div class="pl-10 text-gray-600 space-y-4 mb-8">
                <div><h3 class="font-semibold text-gray-800">アクセス</h3><p>${plan.strategicGuide?.logistics || '記載なし'}</p></div>
                <div><h3 class="font-semibold text-gray-800">持ち物リスト</h3><p>${plan.strategicGuide?.packingList || '記載なし'}</p></div>
            </div>
            <div class="section-header"><span class="text-2xl">🗓️</span><h2 class="section-title">1日のモデルスケジュール</h2></div>
            <div class="pl-2 md:pl-10">${scheduleCardHtml}</div>
        </div>
    </div>
    <div id="modal-overlay" class="modal-overlay" onclick="hideRouteModal()"></div>
    <div id="route-modal" class="modal-content rounded-t-lg"><div class="p-4 border-b flex justify-between items-center">
        <h2 class="text-xl font-bold">移動ルート詳細</h2><button onclick="hideRouteModal()" class="text-2xl">×</button></div>
        <div class="p-4 overflow-y-auto"><div class="flex flex-col md:flex-row gap-6">
            <div class="w-full md:w-1/2 overflow-y-auto max-h-96">${directionsHtml}</div>
            <div class="w-full md:w-1/2 h-96 rounded-lg shadow-md"><div id="map" style="width:100%;height:100%;"></div></div>
        </div></div>
    </div>
    <script>
        let map;
        function initMap() {
            const decodedCoords = ${JSON.stringify(decodedCoords)};
            if (!decodedCoords || decodedCoords.length === 0) return;
            map = new google.maps.Map(document.getElementById('map'));
            const routePath = new google.maps.Polyline({ path: decodedCoords, strokeColor: '#FF6347', strokeWeight: 6 });
            routePath.setMap(map);
            const bounds = new google.maps.LatLngBounds();
            decodedCoords.forEach(coord => bounds.extend(coord));
            map.fitBounds(bounds);
        }
        const routeModal = document.getElementById('route-modal'), modalOverlay = document.getElementById('modal-overlay'), body = document.body;
        function showRouteModal() {
            modalOverlay.style.display = 'block'; body.classList.add('modal-open');
            if (typeof google !== 'undefined' && map) setTimeout(() => { google.maps.event.trigger(map, 'resize'); initMap(); }, 300);
        }
        function hideRouteModal() { modalOverlay.style.display = 'none'; body.classList.remove('modal-open'); }
    </script>
    </body></html>`;
}

module.exports = { generateDayPlanHtmlResponse };
