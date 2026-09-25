from pathlib import Path
import sys
from PIL import Image
import numpy as np

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / '.data/map-tools'))
import cv2
cv2.setNumThreads(1)
Image.MAX_IMAGE_PIXELS = None
im = Image.open(root / '.data/map-sources/original-source-response')
im.thumbnail((1800, 900))
im.convert('RGB').save(root / '.data/map-sources/source-preview.jpg')
old = Image.open(root / 'map-generator/assets/maps/giantworldmap/image.png')
print('Old dimensions:', old.size)
old.thumbnail((2054, 1024))
im = Image.open(root / '.data/map-sources/original-source-response')
im.thumbnail((2160, 1080))
sift = cv2.SIFT_create(nfeatures=20000)
def features(image):
    return sift.detectAndCompute(cv2.cvtColor(np.array(image.convert('RGB')), cv2.COLOR_RGB2GRAY), None)
ka, da = features(old)
kb, db = features(im)
matches = cv2.BFMatcher().knnMatch(da, db, k=2)
good = [m for m,n in matches if m.distance < 0.7 * n.distance]
a = np.float32([ka[m.queryIdx].pt for m in good])
b = np.float32([kb[m.trainIdx].pt for m in good])
affine, inliers = cv2.estimateAffine2D(a, b, ransacReprojThreshold=3)
print('old thumbnail -> source thumbnail', affine, 'inliers', int(inliers.sum()), '/', len(good))
print('old thumbnail size', old.size, 'source thumbnail size', im.size)
print('residual p50/p95', np.percentile(np.linalg.norm(a @ affine[:,:2].T + affine[:,2] - b,axis=1)[inliers[:,0]>0],[50,95]))
