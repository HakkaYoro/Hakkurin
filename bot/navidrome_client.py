import aiohttp
import hashlib
import random
import string
import urllib.parse

class NavidromeClient:
    def __init__(self):
        self.base_url = "http://192.168.1.104:30043/rest"
        self.external_url = "https://navi.hakkurei.com/rest"
        self.username = "hakkurin"
        self.password = "***REMOVED***"
        self.client_name = "hakkurin-bot"
        self.version = "1.16.1"
        self.session = None

    async def _get_session(self):
        if self.session is None or self.session.closed:
            self.session = aiohttp.ClientSession()
        return self.session

    def _get_auth_params(self):
        salt = ''.join(random.choices(string.ascii_letters + string.digits, k=6))
        token = hashlib.md5((self.password + salt).encode('utf-8')).hexdigest()
        return {
            "u": self.username,
            "t": token,
            "s": salt,
            "v": self.version,
            "c": self.client_name,
            "f": "json"
        }

    async def search(self, query, limit=5):
        params = self._get_auth_params()
        params.update({
            "query": query,
            "songCount": limit,
            "albumCount": limit,
            "artistCount": limit
        })
        
        session = await self._get_session()
        try:
            async with session.get(f"{self.base_url}/search3", params=params) as resp:
                data = await resp.json()
                return data.get("subsonic-response", {}).get("searchResult3", {})
        except Exception as e:
            print(f"Error searching Navidrome: {e}")
            return {}

    async def get_artist_radio(self, artist_name, count=20):
        params = self._get_auth_params()
        params.update({
            "query": artist_name,
            "songCount": 100,
            "albumCount": 0,
            "artistCount": 0
        })
        
        session = await self._get_session()
        try:
            async with session.get(f"{self.base_url}/search3", params=params) as resp:
                data = await resp.json()
                songs = data.get("subsonic-response", {}).get("searchResult3", {}).get("song", [])
                
                # Filter broadly by artist
                artist_songs = [s for s in songs if artist_name.lower() in s.get("artist", "").lower()]
                if not artist_songs:
                    artist_songs = songs
                    
                random.shuffle(artist_songs)
                return artist_songs[:count]
        except Exception as e:
            print(f"Error getting radio for {artist_name}: {e}")
            return []

    async def get_similar_songs(self, song_ids, count=10):
        if not song_ids:
            return await self.get_random_songs(count)
            
        params = self._get_auth_params()
        # Subsonic API gets similar songs from a single item ID usually, or multiple if supported.
        # We will pick a random ID from the history to base the similarity on, 
        # or just ask Navidrome for `getSimilarSongs2` (which takes id)
        base_id = random.choice(song_ids)
        params.update({"id": base_id, "count": count})
        
        session = await self._get_session()
        try:
            async with session.get(f"{self.base_url}/getSimilarSongs2", params=params) as resp:
                data = await resp.json()
                songs = data.get("subsonic-response", {}).get("similarSongs2", {}).get("song", [])
                if not songs:
                    # Fallback if Last.fm integration is missing or no similar songs found
                    return await self.get_random_songs(count)
                
                random.shuffle(songs)
                return songs[:count]
        except Exception as e:
            print(f"Error fetching similar songs: {e}")
            return await self.get_random_songs(count)

    async def get_random_songs(self, count=10):
        params = self._get_auth_params()
        params.update({"size": count})
        session = await self._get_session()
        try:
            async with session.get(f"{self.base_url}/getRandomSongs", params=params) as resp:
                data = await resp.json()
                return data.get("subsonic-response", {}).get("randomSongs", {}).get("song", [])
        except Exception as e:
            print(f"Error fetching random songs: {e}")
            return []

    async def get_album_songs(self, album_id):
        params = self._get_auth_params()
        params.update({"id": album_id})
        session = await self._get_session()
        try:
            async with session.get(f"{self.base_url}/getAlbum", params=params) as resp:
                data = await resp.json()
                return data.get("subsonic-response", {}).get("album", {}).get("song", [])
        except Exception as e:
            print(f"Error fetching album {album_id}: {e}")
            return []

    def get_stream_url(self, song_id):
        params = self._get_auth_params()
        params["id"] = song_id
        query_string = urllib.parse.urlencode(params)
        return f"{self.base_url}/stream?{query_string}"
        
    def get_cover_url(self, cover_id):
        if not cover_id:
            return None
        params = self._get_auth_params()
        params["id"] = cover_id
        params["size"] = 500
        query_string = urllib.parse.urlencode(params)
        return f"{self.external_url}/getCoverArt?{query_string}"

navidrome_client = NavidromeClient()
